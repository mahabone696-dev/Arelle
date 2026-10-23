import type { Metadata } from "next";
import { Link2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { pct } from "@/components/dashboard/delta";
import { getProjectPage } from "@/server/auth/session";
import { getCitationsView } from "@/server/dashboard/metrics";
import { parseDateRange } from "@/lib/date-range";

export const metadata: Metadata = { title: "Citations" };

const OWNER_LABEL: Record<string, string> = { PRIMARY: "Your site", COMPETITOR: "Competitor", THIRD_PARTY: "Third party" };

export default async function CitationsPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string }>; searchParams: Promise<{ range?: string }> }) {
  const [{ orgSlug, projectId }, sp] = await Promise.all([params, searchParams]);
  const { user } = await getProjectPage(orgSlug, projectId);
  const v = await getCitationsView(user.id, projectId, parseDateRange(sp.range));

  if (v.totalCitations === 0) {
    return (
      <>
        <PageHeader title="Citations" description="The sources AI engines cite when answering your prompts." />
        <EmptyState icon={Link2} title="No citations in this period" description={v.answers ? "None of the analyzed answers cited sources. Try a longer date range." : "Citations are extracted from AI answers after each scan."} />
      </>
    );
  }
  const own = v.domains.filter((d) => d.ownerType === "PRIMARY").reduce((n, d) => n + d.citations, 0);

  return (
    <>
      <PageHeader title="Citations" description="The sources AI engines cite when answering your prompts." />
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricCard label="Citations" value={String(v.totalCitations)} />
          <MetricCard label="Answers with sources" value={pct(v.answers ? v.answersWithCitations / v.answers : 0)} />
          <MetricCard label="Cited domains" value={String(v.domains.length)} />
          <MetricCard label="Your site's share" value={pct(own / v.totalCitations)} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Card className="min-w-0 overflow-x-auto">
            <CardHeader className="pb-4">
              <CardTitle>Top cited domains</CardTitle>
              <CardDescription>Across {v.answers} answers in this period.</CardDescription>
            </CardHeader>
            <table className="w-full min-w-[620px] text-[13px]">
              <thead className="whitespace-nowrap border-y text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Domain</th>
                  <th className="px-3 py-2.5 text-right font-medium">Citations</th>
                  <th className="px-3 py-2.5 text-right font-medium">Share</th>
                  <th className="px-3 py-2.5 text-right font-medium">Prompts</th>
                  <th className="whitespace-nowrap px-3 py-2.5 text-right font-medium" title="Answers citing this domain that mention you">Mention you</th>
                  <th className="px-4 py-2.5 font-medium">Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {v.domains.slice(0, 25).map((d) => (
                  <tr key={d.domain}>
                    <td className="whitespace-nowrap px-4 py-2.5 font-medium">{d.domain}</td>
                    <td className="tabular px-3 py-2.5 text-right">{d.citations}</td>
                    <td className="tabular px-3 py-2.5 text-right">{pct(d.share)}</td>
                    <td className="tabular px-3 py-2.5 text-right">{d.promptsInfluenced}</td>
                    <td className="tabular px-3 py-2.5 text-right">
                      {d.withPrimary} / {d.answers}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge className="whitespace-nowrap" variant={d.ownerType === "THIRD_PARTY" ? "outline" : "default"}>{d.ownerName ? `${OWNER_LABEL[d.ownerType]}: ${d.ownerName}` : (OWNER_LABEL[d.ownerType] ?? d.ownerType)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Citation gap</CardTitle>
              <CardDescription>Third-party sources cited mostly in answers that mention competitors rather than {v.brandName}. Higher = stronger and more frequent association.</CardDescription>
            </CardHeader>
            <CardContent>
              {v.gaps.length ? (
                <ul className="grid gap-3">
                  {v.gaps.map((g) => (
                    <li key={g.domain} className="grid gap-1.5">
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="truncate font-medium">{g.domain}</span>
                        <span className="tabular shrink-0 font-medium">{Math.round(g.gapScore!)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
                        <div className="h-full rounded-full" style={{ width: `${g.gapScore}%`, background: "var(--series-2)" }} />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Cited in {g.answers} answers · {g.withCompetitor} mention a competitor · {g.withPrimary} mention you
                      </p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted-foreground">No gaps: every frequently cited third-party source also appears in answers that mention you.</p>
              )}
              <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">Gap scores show association, not cause. Being listed on a source doesn&apos;t guarantee AI engines will mention you.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
