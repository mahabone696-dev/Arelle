import type { Metadata } from "next";
import { AlertTriangle, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { OnboardingShell } from "../../onboarding-shell";
import { Stepper, stepFromOnboarding } from "../../stepper";
import { loadOnboarding } from "../load";
import { BrandForm } from "./brand-form";
import { ReanalyzeButton } from "./reanalyze-button";
import { reanalyzeAction, saveBrandAction } from "../../actions";

export const metadata: Metadata = { title: "Brand profile" };
export const maxDuration = 300;

interface PageSummary {
  url: string;
  title: string;
  wordCount: number;
}

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export default async function BrandStepPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { user, project, brand, analysis, basePath } = await loadOnboarding(orgSlug, projectId);
  const pages = (Array.isArray(analysis?.pages) ? analysis.pages : []) as unknown as PageSummary[];
  const failed = analysis?.status === "FAILED";
  const aiError = (analysis?.extraction as { aiError?: string } | null)?.aiError;

  return (
    <OnboardingShell user={user} exitHref={`/${orgSlug}`} stepper={<Stepper current="brand" reached={stepFromOnboarding(project.onboardingStep)} basePath={basePath} />}>
      <div className="grid gap-8 lg:grid-cols-[1fr_300px]">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{failed ? "Tell us about your brand" : "We found your brand"}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {failed
              ? "We couldn't analyze the website automatically. Fill in the details below — they drive competitor and prompt suggestions."
              : "Review and edit what we extracted. This profile drives competitor and prompt suggestions."}
          </p>
          {failed ? (
            <div role="alert" className="mt-5 flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex-1">
                <div className="font-medium">Website analysis failed</div>
                <div className="text-muted-foreground">{analysis?.errorMessage}</div>
              </div>
              <ReanalyzeButton action={reanalyzeAction.bind(null, orgSlug, projectId)} />
            </div>
          ) : null}
          {!failed && analysis?.method === "DETERMINISTIC" ? (
            <div className="mt-5 rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-[13px]">
              {aiError
                ? "AI extraction was unavailable for this analysis, so these fields were read from your page metadata only. Please review them carefully."
                : "AI extraction isn't configured, so these fields were read from your page metadata only. Fill in the category and audience to get useful prompts."}
            </div>
          ) : null}
          <Card className="mt-6">
            <CardContent className="pt-5">
              <BrandForm
                action={saveBrandAction.bind(null, orgSlug, projectId)}
                defaults={{
                  brandName: brand?.name ?? project.name,
                  industry: brand?.industry ?? "",
                  description: brand?.description ?? "",
                  products: asStrings(brand?.products),
                  services: asStrings(brand?.services),
                  targetCustomers: brand?.targetCustomers ?? [],
                  markets: brand?.markets ?? [],
                  topics: brand?.topics ?? [],
                  aliases: brand?.aliases ?? [],
                }}
              />
            </CardContent>
          </Card>
        </div>

        <aside className="lg:pt-16">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-2">
                Website analysis
                {analysis && !failed ? <Badge variant={analysis.method === "AI" ? "success" : "warning"}>{analysis.method === "AI" ? "AI extracted" : "Metadata only"}</Badge> : null}
              </CardTitle>
              <CardDescription>{project.domain}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-[13px]">
              {analysis && !failed ? (
                <>
                  <dl className="grid grid-cols-2 gap-y-1.5">
                    <dt className="text-muted-foreground">Pages read</dt>
                    <dd className="tabular text-right">{analysis.pagesCrawled}</dd>
                    <dt className="text-muted-foreground">robots.txt</dt>
                    <dd className="text-right">{analysis.robotsStatus?.startsWith("PARSED") ? "Respected" : analysis.robotsStatus?.startsWith("MISSING") ? "None found" : "Unavailable"}</dd>
                    {analysis.aiModel ? (
                      <>
                        <dt className="text-muted-foreground">Model</dt>
                        <dd className="truncate text-right">{analysis.aiModel}</dd>
                      </>
                    ) : null}
                  </dl>
                  <details className="group">
                    <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Pages analyzed</summary>
                    <ul className="mt-2 grid gap-1.5">
                      {pages.map((p) => (
                        <li key={p.url} className="flex items-start gap-2">
                          <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0">
                            <span className="block truncate">{p.title || new URL(p.url).pathname}</span>
                            <span className="block truncate text-xs text-muted-foreground">{new URL(p.url).pathname}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <ReanalyzeButton action={reanalyzeAction.bind(null, orgSlug, projectId)} variant="ghost" label="Re-analyze website" />
                </>
              ) : (
                <p className="text-muted-foreground">{failed ? "No pages could be read." : "Not analyzed yet."}</p>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </OnboardingShell>
  );
}
