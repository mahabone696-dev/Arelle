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

export const metadata: Metadata = { title: "Overview" };

const ENGINES = ["ChatGPT", "Gemini", "Perplexity"] as const;

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
  searchParams: Promise<{ range?: string; onboarded?: string }>;
}) {
  const [{ orgSlug, projectId }, { range, onboarded }] = await Promise.all([params, searchParams]);
  const { project } = await getProjectPage(orgSlug, projectId);
  // Authorized above via getProjectPage.
  const [activePrompts, competitors] = await Promise.all([
    db.prompt.count({ where: { projectId, isActive: true } }),
    db.competitor.count({ where: { projectId, isActive: true } }),
  ]);
  const rangeLabel = DATE_RANGES.find((r) => r.key === parseDateRange(range))!.label;

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
            <div className="text-[13px] text-muted-foreground">Confirm your brand profile, competitors and prompts to start tracking AI visibility.</div>
          </div>
          <Button asChild size="sm">
            <Link href={`/${orgSlug}/onboarding/${projectId}`}>
              Continue setup <ArrowRight />
            </Link>
          </Button>
        </Card>
      ) : (
        <Card className="mb-4 flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
          {onboarded ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : null}
          <div className="flex-1">
            <div className="text-sm font-medium">{onboarded ? "Setup complete" : "Ready for your first scan"}</div>
            <div className="text-[13px] text-muted-foreground">
              Tracking <span className="tabular font-medium text-foreground">{activePrompts}</span> prompts against <span className="tabular font-medium text-foreground">{competitors}</span> competitors. Scans that query AI engines arrive in the next release.
            </div>
          </div>
          <Button size="sm" disabled title="Available in the next release">
            Start First Scan
          </Button>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-muted-foreground">AI Visibility</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-1.5">
              <span className="tabular text-5xl font-semibold tracking-tight">—</span>
              <span className="text-lg text-muted-foreground">/ 100</span>
            </div>
            <p className="mt-3 text-[13px] text-muted-foreground">No scans yet. Your score appears after the first scan completes.</p>
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-4 lg:col-span-2">
          <MetricCard label="Mention rate" value={null} />
          <MetricCard label="Share of voice" value={null} />
          <MetricCard label="Citation rate" value={null} />
          <MetricCard label="Average position" value={null} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Visibility over time</CardTitle>
            <CardDescription>Daily visibility score across all AI engines.</CardDescription>
          </CardHeader>
          <CardContent>
            <EmptyState icon={LineChart} title="No history yet" description="Trends appear once you have results from at least one scan." className="py-10" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AI engine performance</CardTitle>
            <CardDescription>Visibility score by engine.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {ENGINES.map((engine) => (
                <li key={engine} className="flex items-center justify-between py-2.5 text-sm">
                  <span>{engine}</span>
                  <span className="tabular text-muted-foreground">Not scanned</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
