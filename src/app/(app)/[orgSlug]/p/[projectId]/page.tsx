import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, CheckCircle2, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { db } from "@/server/db";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getProjectPage } from "@/server/auth/session";
import { DATE_RANGES, parseDateRange } from "@/lib/date-range";
import { countryName, languageName } from "@/lib/i18n";
import { can } from "@/server/auth/policy";
import { listRecentScans, previewScan } from "@/server/scans/service";
import { UNAVAILABLE_LABELS } from "@/server/providers/registry";
import { getOverview } from "@/server/dashboard/metrics";
import { ScanControl } from "@/components/scans/scan-control";
import { ScanStatusBadge, formatUsd } from "@/components/scans/scan-status-badge";
import { ChartLegend, TrendChart } from "@/components/charts/trend-chart";
import { Delta, num1, pct } from "@/components/dashboard/delta";
import { ImpactBadge, OPPORTUNITY_LABELS } from "@/components/actions/labels";
import { topOpportunities } from "@/server/opportunities/service";
import { hasFeature } from "@/server/billing/limits";
import type { OpportunityEvidence } from "@/server/opportunities/rules";
import { runScanAction } from "./scan-actions";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
  searchParams: Promise<{ range?: string; onboarded?: string }>;
}) {
  const [{ orgSlug, projectId }, { range: rawRange, onboarded }] = await Promise.all([
    params,
    searchParams,
  ]);
  const range = parseDateRange(rawRange);
  const { project, user, access } = await getProjectPage(orgSlug, projectId);
  // Authorized above via getProjectPage.
  const [activePrompts, competitors, preview, recentScans, o] = await Promise.all([
    db.prompt.count({ where: { projectId, isActive: true } }),
    db.competitor.count({ where: { projectId, isActive: true } }),
    previewScan(user.id, projectId),
    listRecentScans(user.id, projectId),
    getOverview(user.id, projectId, range),
  ]);
  const [top, actionEngine] = await Promise.all([topOpportunities(user.id, projectId, 4), hasFeature(access.organizationId, "actionEngine")]);
  const activeScan = recentScans.find((s) => s.status === "QUEUED" || s.status === "RUNNING");
  const rangeLabel = DATE_RANGES.find((r) => r.key === range)!.label;
  const base = `/${orgSlug}/p/${projectId}`;
  const p = o.primary;
  const vsPrev = "vs previous period";
  const trendData = o.series.map((pt) => ({ date: pt.date, ...pt.scores }));
  const trendSeries = o.seriesSubjects.map((s, i) => ({
    key: s.id ?? "primary",
    name: s.isPrimary ? `${s.name} (you)` : s.name,
    colorIndex: i,
    emphasis: s.isPrimary,
  }));

  return (
    <>
      <PageHeader
        title="Overview"
        description={`${project.domain} · ${countryName(project.country)} · ${languageName(project.language)} · ${rangeLabel}`}
      />

      {!project.onboardingCompletedAt ? (
        <Card className="mb-4 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          <div className="flex-1">
            <div className="text-sm font-medium">Finish setting up {project.name}</div>
            <div className="text-[13px] text-muted-foreground">
              Confirm your brand profile, competitors and prompts to start tracking AI visibility.
            </div>
          </div>
          {can(access.role, "project:update") ? (
            <Button asChild size="sm">
              <Link href={`/${orgSlug}/onboarding/${projectId}`}>
                Continue setup <ArrowRight />
              </Link>
            </Button>
          ) : null}
        </Card>
      ) : (
        <Card className="mb-4 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          {onboarded ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : null}
          <div className="flex-1">
            <div className="text-sm font-medium">
              {onboarded
                ? "Setup complete"
                : recentScans.length
                  ? "AI scans"
                  : "Ready for your first scan"}
            </div>
            <div className="text-[13px] text-muted-foreground">
              Tracking <span className="tabular font-medium text-foreground">{activePrompts}</span>{" "}
              prompts against{" "}
              <span className="tabular font-medium text-foreground">{competitors}</span> competitors
              {o.lastAnalyzedAt
                ? ` · last results ${o.lastAnalyzedAt.toISOString().slice(0, 10)}`
                : ""}
              .
            </div>
          </div>
          <ScanControl
            orgSlug={orgSlug}
            projectId={projectId}
            activeScanId={activeScan?.id ?? null}
            canRun={can(access.role, "scan:run")}
            run={runScanAction.bind(null, orgSlug, projectId)}
            preview={{
              promptCount: preview.promptCount,
              providerCount: preview.providerCount,
              expectedQueryCount: preview.expectedQueryCount,
              estimatedCost: preview.estimatedCost,
              providers: preview.providers.map((pr) => ({
                displayName: pr.displayName,
                model: pr.model,
                localized: pr.localized,
              })),
              unavailable: preview.unavailable
                .filter((u) => u.reason !== "DISABLED")
                .map((u) => ({ displayName: u.displayName, label: UNAVAILABLE_LABELS[u.reason] })),
              blockedReason: preview.blockedReason,
              upgradeRequired: preview.upgradeRequired,
            }}
          />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-muted-foreground">AI Visibility</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-1.5">
              <span className="tabular text-5xl font-semibold tracking-tight">
                {p ? num1(p.visibilityScore) : "—"}
              </span>
              <span className="text-lg text-muted-foreground">/ 100</span>
            </div>
            <div className="mt-2">
              {p ? <Delta value={p.deltas?.visibilityScore} suffix={vsPrev} /> : null}
            </div>
            <p className="mt-3 text-[13px] text-muted-foreground">
              {p
                ? `Across ${o.answers} AI answers in this period.`
                : "No results in this period. Your score appears after a scan completes."}
            </p>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          <MetricCard
            label="Mention rate"
            hint="Share of answers that mention your brand"
            value={p ? pct(p.mentionRate) : null}
            footer={p ? <Delta value={p.deltas?.mentionRate} unit=" pts" /> : undefined}
          />
          <MetricCard
            label="Share of voice"
            hint="Your mentions among all tracked brands' mentions"
            value={p ? pct(p.shareOfVoice) : null}
            footer={p ? <Delta value={p.deltas?.shareOfVoice} unit=" pts" /> : undefined}
          />
          <MetricCard
            label="Citation rate"
            hint="Share of answers citing your website"
            value={p ? pct(p.citationRate) : null}
            footer={p ? <Delta value={p.deltas?.citationRate} unit=" pts" /> : undefined}
          />
          <MetricCard
            label="Average position"
            hint="Your rank among brands when mentioned (lower is better)"
            value={p?.averagePosition ? num1(p.averagePosition) : null}
            footer={p ? <Delta value={p.deltas?.averagePosition} better="down" /> : undefined}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Visibility over time</CardTitle>
            <CardDescription>
              Visibility score per scan day, across all AI engines.
              {o.series.length === 1 ? " All results so far are from one day — the line appears once scans span several days." : ""}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {trendData.length ? (
              <div className="grid gap-3">
                <TrendChart data={trendData} series={trendSeries} />
                <ChartLegend series={trendSeries} />
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    View as table
                  </summary>
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="text-muted-foreground">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Date</th>
                          {trendSeries.map((s) => (
                            <th
                              key={s.key}
                              className="whitespace-nowrap py-1 pr-3 text-right font-medium"
                            >
                              {s.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="tabular">
                        {o.series.map((pt) => (
                          <tr key={pt.date} className="border-t">
                            <td className="whitespace-nowrap py-1 pr-3">{pt.date}</td>
                            {trendSeries.map((s) => (
                              <td key={s.key} className="py-1 pr-3 text-right">
                                {num1(pt.scores[s.key])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </div>
            ) : (
              <EmptyState
                icon={LineChart}
                title="No history yet"
                description="Trends appear once you have results from at least one scan."
                className="py-10"
              />
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Top opportunities</CardTitle>
            <CardDescription>From the last 30 days of answers, by impact score.</CardDescription>
          </CardHeader>
          <CardContent>
            {top.items.length ? (
              <ul className="divide-y text-[13px]">
                {top.items.map((op) => {
                  const e = op.evidence as unknown as OpportunityEvidence;
                  const rec = op.recommendations[0];
                  return (
                    <li key={op.id}>
                      <Link
                        href={rec && actionEngine ? `${base}/actions/${rec.id}` : `${base}/opportunities`}
                        className="grid gap-1 py-2.5 hover:text-foreground"
                      >
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          <ImpactBadge score={op.impactScore} />
                          {OPPORTUNITY_LABELS[op.type]}
                        </span>
                        <span className="font-medium">{op.title}</span>
                        {e.potentialGain && e.potentialGain >= 0.5 && e.leader ? (
                          <span className="text-xs text-muted-foreground">
                            Gap to {e.leader.name} here ≈ {e.potentialGain.toFixed(1)} pts of your
                            overall score
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                {p
                  ? "No open opportunities right now."
                  : "Opportunities appear after your first scan."}
              </p>
            )}
            {top.items.length ? (
              <Link
                href={`${base}/opportunities`}
                className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                All opportunities
                {top.byType.CITATION_GAP
                  ? ` · ${top.byType.CITATION_GAP} citation gap${top.byType.CITATION_GAP === 1 ? "" : "s"}`
                  : ""}{" "}
                <ArrowRight className="size-3" />
              </Link>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>AI engine performance</CardTitle>
            <CardDescription>Your visibility score by engine.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {o.engines.map((e) => (
                <li
                  key={e.providerId}
                  className="flex items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <span>{e.name}</span>
                  {e.score !== null ? (
                    <span className="flex items-baseline gap-2">
                      <Delta value={e.delta} />
                      <span className="tabular w-10 text-right font-semibold">{num1(e.score)}</span>
                    </span>
                  ) : (
                    <span className="text-right text-xs text-muted-foreground">{e.note}</span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader>
            <CardTitle>Competitor performance</CardTitle>
            <CardDescription>Same answers, scored for each brand.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto pt-2">
            <table className="w-full text-[13px]">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Brand</th>
                  <th className="py-2 pr-3 text-right font-medium">Visibility</th>
                  <th className="py-2 pr-3 text-right font-medium">Mentions</th>
                  <th className="py-2 pr-3 text-right font-medium">SoV</th>
                  <th className="whitespace-nowrap py-2 text-right font-medium">Avg. pos.</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {o.competitorTable.map((r) => (
                  <tr key={r.id ?? "primary"} className={r.isPrimary ? "font-medium" : undefined}>
                    <td className="whitespace-nowrap py-2 pr-3">
                      {r.isPrimary ? `${r.name} (you)` : r.name}
                    </td>
                    <td className="tabular py-2 pr-3 text-right">
                      {p ? num1(r.metrics.visibilityScore) : "—"}
                    </td>
                    <td className="tabular py-2 pr-3 text-right">
                      {p ? pct(r.metrics.mentionRate) : "—"}
                    </td>
                    <td className="tabular py-2 pr-3 text-right">
                      {p ? pct(r.metrics.shareOfVoice) : "—"}
                    </td>
                    <td className="tabular py-2 text-right">{num1(r.metrics.averagePosition)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {recentScans.length ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Recent scans</CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            <ul className="divide-y text-[13px]">
              {recentScans.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`${base}/scans/${s.id}`}
                    className="flex flex-wrap items-center gap-3 py-2.5 hover:text-foreground"
                  >
                    <ScanStatusBadge status={s.status} />
                    <span className="tabular">
                      {s.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                    </span>
                    <span className="tabular text-muted-foreground">
                      {s.completedCount}/{s.expectedQueryCount} answers
                      {s.failedCount ? ` · ${s.failedCount} failed` : ""}
                    </span>
                    <span className="tabular ml-auto text-muted-foreground">
                      {formatUsd(Number(s.actualCost))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}
