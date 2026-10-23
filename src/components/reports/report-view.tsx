import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChartLegend, TrendChart } from "@/components/charts/trend-chart";
import { Delta, num1, pct } from "@/components/dashboard/delta";
import { ImpactBadge, OPPORTUNITY_LABELS, RECOMMENDATION_LABELS } from "@/components/actions/labels";
import type { ProjectReport } from "@/server/dashboard/metrics";
import type { ReportBranding } from "@/server/reports/service";
import { DATE_RANGES } from "@/lib/date-range";

const date = (d: Date) => d.toISOString().slice(0, 10);

/** One visibility report. Server-rendered; also used for print / PDF. */
export function ReportView({ report: r, title, branding = {} }: { report: ProjectReport; title?: string | null; branding?: ReportBranding }) {
  const rangeLabel = DATE_RANGES.find((d) => d.key === r.range)!.label;
  const series = r.seriesSubjects.map((s, i) => ({ key: s.id ?? "primary", name: s.isPrimary ? `${s.name} (you)` : s.name, colorIndex: i, emphasis: s.isPrimary }));
  const accent = branding.accentColor ?? undefined;
  return (
    <article className="mx-auto grid max-w-5xl gap-4 print:max-w-none">
      <header className="grid gap-1 border-b pb-4" style={accent ? { borderColor: accent } : undefined}>
        {branding.agencyName ? <div className="text-xs font-medium uppercase tracking-wide" style={accent ? { color: accent } : undefined}>Prepared by {branding.agencyName}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title || `AI visibility report — ${r.brandName}`}</h1>
        <p className="text-[13px] text-muted-foreground">
          {r.project.domain} · {rangeLabel} · {r.answers} AI answers · generated {date(r.generatedAt)} UTC
          {r.isDemo ? " · demo data" : ""}
        </p>
      </header>

      {!r.primary ? (
        <Card className="px-5 py-8 text-center text-[13px] text-muted-foreground">No analyzed AI answers in this period yet.</Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Card className="sm:col-span-2 lg:col-span-1">
              <CardHeader>
                <CardTitle className="text-muted-foreground">AI Visibility</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-baseline gap-1">
                  <span className="tabular text-4xl font-semibold">{num1(r.primary.visibilityScore)}</span>
                  <span className="text-muted-foreground">/ 100</span>
                </div>
                <Delta value={r.primary.deltas?.visibilityScore} suffix="vs previous period" />
              </CardContent>
            </Card>
            {[
              ["Mention rate", pct(r.primary.mentionRate), r.primary.deltas?.mentionRate, " pts", "up"],
              ["Share of voice", pct(r.primary.shareOfVoice), r.primary.deltas?.shareOfVoice, " pts", "up"],
              ["Citation rate", pct(r.primary.citationRate), r.primary.deltas?.citationRate, " pts", "up"],
              ["Average position", num1(r.primary.averagePosition), r.primary.deltas?.averagePosition, "", "down"],
            ].map(([label, value, delta, unit, better]) => (
              <Card key={label as string}>
                <CardHeader>
                  <CardTitle className="text-muted-foreground">{label as string}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="tabular text-2xl font-semibold">{value as string}</div>
                  <Delta value={delta as number | null | undefined} unit={unit as string} better={better as "up" | "down"} />
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card className="min-w-0 break-inside-avoid">
              <CardHeader>
                <CardTitle>Visibility over time</CardTitle>
                <CardDescription>Per scan day, all AI engines.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <TrendChart data={r.series.map((p) => ({ date: p.date, ...p.scores }))} series={series} height={220} />
                <ChartLegend series={series} />
              </CardContent>
            </Card>
            <Card className="min-w-0 break-inside-avoid">
              <CardHeader>
                <CardTitle>Competitor comparison</CardTitle>
                <CardDescription>Same answers, scored for each brand.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead className="whitespace-nowrap text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-3 font-medium">Brand</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Visibility</th>
                      <th className="py-1.5 pr-3 text-right font-medium">Mentions</th>
                      <th className="py-1.5 text-right font-medium">SoV</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {r.competitors.map((c) => (
                      <tr key={c.id ?? "primary"} className={c.isPrimary ? "font-medium" : undefined}>
                        <td className="whitespace-nowrap py-1.5 pr-3">{c.isPrimary ? `${c.name} (you)` : c.name}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{num1(c.metrics.visibilityScore)}</td>
                        <td className="tabular py-1.5 pr-3 text-right">{pct(c.metrics.mentionRate)}</td>
                        <td className="tabular py-1.5 text-right">{pct(c.metrics.shareOfVoice)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Section title="Top winning prompts" empty="No prompts where you're mentioned yet.">
              {r.winning.map((p) => (
                <Row key={p.promptId} label={p.prompt.text} value={num1(p.visibility)} note={`${pct(p.mentionRate)} of answers`} />
              ))}
            </Section>
            <Section title="Top losing prompts" empty="None: you appear in every prompt's latest answers.">
              {r.losing.map((p) => (
                <Row key={p.promptId} label={p.prompt.text} value={num1(p.visibility)} note={p.competitor ? `${p.competitor} leads` : undefined} />
              ))}
            </Section>
            <Section title="Citation gaps" empty="No citation gaps found.">
              {r.citationGaps.map((d) => (
                <Row key={d.domain} label={d.domain} value={String(d.gapScore)} note={`${d.withCompetitor} of ${d.answers} answers citing it mention a competitor, ${d.withPrimary} mention you`} />
              ))}
            </Section>
            <Section title="Top opportunities" empty="No open opportunities.">
              {r.opportunities.map((o) => (
                <li key={o.id} className="grid gap-0.5 py-2">
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ImpactBadge score={o.impactScore} /> {OPPORTUNITY_LABELS[o.type]}
                  </span>
                  <span className="font-medium">{o.title}</span>
                </li>
              ))}
            </Section>
          </div>

          <Card className="break-inside-avoid">
            <CardHeader>
              <CardTitle>Actions completed</CardTitle>
              <CardDescription>Observed visibility before and after each change. Observation, not proof of cause.</CardDescription>
            </CardHeader>
            <CardContent>
              {r.actionsCompleted.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead className="whitespace-nowrap text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="py-1.5 pr-3 font-medium">Action</th>
                        <th className="py-1.5 pr-3 font-medium">Implemented</th>
                        <th className="py-1.5 pr-3 text-right font-medium">Before</th>
                        <th className="py-1.5 pr-3 text-right font-medium">After</th>
                        <th className="py-1.5 text-right font-medium">Observed change</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {r.actionsCompleted.map((a, i) => (
                        <tr key={i}>
                          <td className="py-1.5 pr-3">
                            <div>{a.title}</div>
                            <div className="text-xs text-muted-foreground">{RECOMMENDATION_LABELS[a.type]}</div>
                          </td>
                          <td className="tabular whitespace-nowrap py-1.5 pr-3">{date(a.implementedAt)}</td>
                          <td className="tabular py-1.5 pr-3 text-right">{a.before === null ? "—" : num1(a.before)}</td>
                          <td className="tabular py-1.5 pr-3 text-right">{a.after === null ? "—" : num1(a.after)}</td>
                          <td className="whitespace-nowrap py-1.5 text-right">{a.delta === null ? <span className="text-xs text-muted-foreground">after next scan</span> : <><Delta value={a.delta} /> <span className="text-xs text-muted-foreground">{a.days} d, {a.answers} answers</span></>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">No actions marked as implemented yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span>Scores are computed from sampled AI answers and change between runs. They describe what answers contained, not why engines chose them.</span>
        {branding.agencyName ? null : <Badge variant="outline">Arelle</Badge>}
      </footer>
    </article>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <Card className="min-w-0 break-inside-avoid">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children.length ? <ul className="divide-y text-[13px]">{children}</ul> : <p className="text-[13px] text-muted-foreground">{empty}</p>}</CardContent>
    </Card>
  );
}

function Row({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block">{label}</span>
        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
      </span>
      <span className="tabular shrink-0 font-medium">{value}</span>
    </li>
  );
}
