import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BarCompare } from "@/components/charts/bar-compare";
import { ChartLegend, TrendChart } from "@/components/charts/trend-chart";
import { Delta, num1, pct } from "@/components/dashboard/delta";
import { getProjectPage } from "@/server/auth/session";
import { can } from "@/server/auth/policy";
import { getCompetitorsView } from "@/server/dashboard/metrics";
import { parseDateRange } from "@/lib/date-range";

export const metadata: Metadata = { title: "Competitors" };

export default async function CompetitorsPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string }>; searchParams: Promise<{ range?: string }> }) {
  const [{ orgSlug, projectId }, sp] = await Promise.all([params, searchParams]);
  const { user, access } = await getProjectPage(orgSlug, projectId);
  const range = parseDateRange(sp.range);
  const v = await getCompetitorsView(user.id, projectId, range);
  const base = `/${orgSlug}/p/${projectId}`;
  // Editing goes through onboarding, which needs project:update; viewers don't get a dead link.
  const edit = can(access.role, "project:update") ? (
    <Button asChild variant="outline" size="sm">
      <Link href={`/${orgSlug}/onboarding/${projectId}/competitors`}>Edit competitors</Link>
    </Button>
  ) : undefined;
  if (v.rows.length <= 1) {
    return (
      <>
        <PageHeader title="Competitors" description="Compare your AI visibility against competing brands." />
        <EmptyState icon={Users} title="No competitors yet" description="Add competitors so we can measure share of voice in AI answers." action={edit} />
      </>
    );
  }
  // Fixed color per brand: index in the subject list (you first, then competitors by creation).
  const colored = v.rows.map((r, i) => ({ ...r, colorIndex: i }));
  const ranked = [...colored].sort((a, b) => b.metrics.visibilityScore - a.metrics.visibilityScore);
  const series = colored.slice(0, 6).map((r) => ({ key: r.id ?? "primary", name: r.isPrimary ? `${r.name} (you)` : r.name, colorIndex: r.colorIndex, emphasis: r.isPrimary }));

  return (
    <>
      <PageHeader title="Competitors" description="The same AI answers, scored for each brand." actions={edit} />
      {v.answers === 0 ? (
        <EmptyState title="No answers in this period" description="Run a scan, or pick a longer date range." />
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Visibility score</CardTitle>
                <CardDescription>{v.answers} answers in this period.</CardDescription>
              </CardHeader>
              <CardContent>
                <BarCompare items={ranked.map((r) => ({ name: r.isPrimary ? `${r.name} (you)` : r.name, value: r.metrics.visibilityScore, colorIndex: r.colorIndex, emphasis: r.isPrimary }))} />
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle>Over time</CardTitle>
                <CardDescription>Visibility per scan day.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <TrendChart data={v.series.map((p) => ({ date: p.date, ...p.scores }))} series={series} height={220} />
                <ChartLegend series={series} />
              </CardContent>
            </Card>
          </div>

          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[13px]">
              <thead className="whitespace-nowrap border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Brand</th>
                  <th className="px-3 py-2.5 text-right font-medium">Visibility</th>
                  <th className="px-3 py-2.5 text-right font-medium">Change</th>
                  <th className="px-3 py-2.5 text-right font-medium">Mention rate</th>
                  <th className="px-3 py-2.5 text-right font-medium">Share of voice</th>
                  <th className="px-3 py-2.5 text-right font-medium">Avg. position</th>
                  <th className="px-4 py-2.5 text-right font-medium">Citation rate</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ranked.map((r) => (
                  <tr key={r.id ?? "primary"} className={r.isPrimary ? "bg-accent/50 font-medium" : undefined}>
                    <td className="whitespace-nowrap px-4 py-2.5">{r.isPrimary ? `${r.name} (you)` : r.name}</td>
                    <td className="tabular px-3 py-2.5 text-right">{num1(r.metrics.visibilityScore)}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Delta value={r.delta} />
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{pct(r.metrics.mentionRate)}</td>
                    <td className="tabular px-3 py-2.5 text-right">{pct(r.metrics.shareOfVoice)}</td>
                    <td className="tabular px-3 py-2.5 text-right">{num1(r.metrics.averagePosition)}</td>
                    <td className="tabular px-4 py-2.5 text-right">{pct(r.metrics.citationRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div>
            <h2 className="text-sm font-medium">Prompts they win</h2>
            <p className="mb-3 text-[13px] text-muted-foreground">Prompts where the competitor appears in answers that don&apos;t mention {v.brandName}.</p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {v.wins.map((w) => (
                <Card key={w.competitorId} className="min-w-0">
                  <CardHeader>
                    <CardTitle className="flex items-center justify-between">
                      {w.name}
                      <span className="tabular text-xs font-normal text-muted-foreground">{w.prompts.length} prompts</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {w.prompts.length ? (
                      <ul className="divide-y text-[13px]">
                        {w.prompts.slice(0, 5).map((p) => (
                          <li key={p.promptId}>
                            <Link href={`${base}/prompts/${p.promptId}?range=${range}`} className="flex items-baseline gap-2 py-2 hover:text-foreground">
                              <span className="flex-1">{p.text}</span>
                              <span className="tabular shrink-0 text-xs text-muted-foreground">
                                {p.answers}× · best #{p.bestPosition}
                              </span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-muted-foreground">None — wherever {w.name} appears, so do you.</p>
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
