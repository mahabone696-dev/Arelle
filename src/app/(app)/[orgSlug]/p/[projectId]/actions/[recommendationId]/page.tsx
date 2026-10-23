import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Delta, num1 } from "@/components/dashboard/delta";
import { ImpactBadge, OPPORTUNITY_LABELS, RECOMMENDATION_LABELS, RecommendationStatusBadge } from "@/components/actions/labels";
import { RecommendationControls } from "@/components/actions/recommendation-controls";
import { getProjectPage } from "@/server/auth/session";
import { can } from "@/server/auth/policy";
import { getRecommendation } from "@/server/opportunities/service";
import { isAppError } from "@/lib/errors";
import { implementAction, planAction, setRecommendationStatusAction } from "../../action-engine-actions";

export const metadata: Metadata = { title: "Recommendation" };

const date = (d: Date) => d.toISOString().slice(0, 10);

export default async function RecommendationPage({ params }: { params: Promise<{ orgSlug: string; projectId: string; recommendationId: string }> }) {
  const { orgSlug, projectId, recommendationId } = await params;
  const { user, access } = await getProjectPage(orgSlug, projectId);
  const view = await getRecommendation(user.id, projectId, recommendationId).catch((e) => {
    if (isAppError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  });
  const { rec, prompt, siblings } = view;
  const base = `/${orgSlug}/p/${projectId}`;
  const action = rec.actions.find((a) => a.status !== "ABANDONED");
  const measurements = action?.measurements ?? [];
  const latest = measurements[measurements.length - 1];
  const steps = rec.suggestedAction.split("\n").filter(Boolean);

  return (
    <>
      <Link href={`${base}/actions`} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Actions
      </Link>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <RecommendationStatusBadge status={rec.status} />
          <span>{RECOMMENDATION_LABELS[rec.type]}</span>
          <span>· from {OPPORTUNITY_LABELS[rec.opportunity.type].toLowerCase()}</span>
        </div>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-balance">{rec.title}</h1>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-4">
          <Card>
            <CardContent className="grid gap-5 pt-5">
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why</h2>
                <p className="mt-1.5 text-sm">{rec.reason}</p>
              </section>
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Where</h2>
                {rec.targetUrl ? (
                  <a href={rec.targetUrl} target="_blank" rel="noopener noreferrer nofollow" className="mt-1.5 inline-flex max-w-full items-center gap-1 break-all text-sm underline underline-offset-2">
                    {rec.targetUrl} <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                  </a>
                ) : (
                  <p className="mt-1.5 text-sm text-muted-foreground">Your website</p>
                )}
                {rec.targetUrl && rec.type.startsWith("CREATE") ? <p className="mt-1 text-xs text-muted-foreground">Suggested address for a new page — use whatever fits your site structure.</p> : null}
              </section>
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">How</h2>
                <ol className="mt-1.5 grid list-decimal gap-1.5 pl-5 text-sm marker:text-muted-foreground">
                  {steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Expected impact</h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
                  <ImpactBadge level={rec.estimatedImpact} />
                  <span className="text-[13px] text-muted-foreground">Based on prompt priority, intent and how strongly competitors lead. Not a guarantee — AI engines decide what they cite.</span>
                </div>
              </section>
            </CardContent>
          </Card>

          {action?.status === "IMPLEMENTED" && action.implementedAt ? (
            <Card>
              <CardHeader>
                <CardTitle>Observed change after implementation</CardTitle>
                <CardDescription>
                  Visibility {action.scopePromptIds.length === 1 ? "for this prompt" : action.scopePromptIds.length ? `across ${action.scopePromptIds.length} prompts` : "across all prompts"}, before vs. after {date(action.implementedAt)}. An observation, not proof of cause.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <div className="text-xs text-muted-foreground">Before</div>
                    <div className="tabular text-2xl font-semibold">{action.baselineScore === null ? "—" : num1(action.baselineScore)}</div>
                    <div className="text-xs text-muted-foreground">{action.baselineAnswers ?? 0} answers, 30 days before</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{latest ? (latest.daysSinceImplementation === 0 ? "Same day" : `${latest.daysSinceImplementation} days later`) : "After"}</div>
                    <div className="tabular text-2xl font-semibold">{latest ? num1(latest.afterScore) : "—"}</div>
                    <div className="text-xs text-muted-foreground">{latest ? `${latest.afterAnswers} answers since` : "after the next scan"}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">Change</div>
                    <div className="text-2xl font-semibold">{latest ? <Delta value={latest.delta} /> : "—"}</div>
                  </div>
                </div>
                {action.baselineScore === null ? <p className="text-[13px] text-muted-foreground">There were no analyzed answers in the 30 days before this date, so there&apos;s no baseline to compare with.</p> : null}
                {latest && latest.afterAnswers < 6 ? <p className="text-[13px] text-muted-foreground">Based on few answers so far — expect this to move as more scans come in.</p> : null}
                {measurements.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[13px]">
                      <thead className="whitespace-nowrap text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="py-1.5 pr-3 font-medium">Scan</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Days after</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Before</th>
                          <th className="py-1.5 pr-3 text-right font-medium">After</th>
                          <th className="py-1.5 pr-3 text-right font-medium">Change</th>
                          <th className="py-1.5 text-right font-medium">Answers</th>
                        </tr>
                      </thead>
                      <tbody className="tabular divide-y">
                        {measurements.map((m) => (
                          <tr key={m.id}>
                            <td className="whitespace-nowrap py-1.5 pr-3">{date(m.measuredAt)}</td>
                            <td className="py-1.5 pr-3 text-right">{m.daysSinceImplementation}</td>
                            <td className="py-1.5 pr-3 text-right">{num1(m.beforeScore)}</td>
                            <td className="py-1.5 pr-3 text-right">{num1(m.afterScore)}</td>
                            <td className="py-1.5 pr-3 text-right">
                              <Delta value={m.delta} />
                            </td>
                            <td className="py-1.5 text-right">{m.afterAnswers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="order-first grid min-w-0 content-start gap-4 lg:order-none">
          <Card>
            <CardHeader>
              <CardTitle>Status</CardTitle>
              <CardDescription>
                {rec.status === "IMPLEMENTED" && action?.implementedAt
                  ? `Implemented ${date(action.implementedAt)}.`
                  : rec.status === "PLANNED" && action
                    ? `Planned ${date(action.plannedAt)}.`
                    : rec.status === "DISMISSED"
                      ? "Dismissed."
                      : "Not started."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {action?.status === "IMPLEMENTED" ? (
                <dl className="grid gap-1 text-[13px]">
                  {action.implementationUrl ? (
                    <>
                      <dt className="text-muted-foreground">URL</dt>
                      <dd className="break-all">
                        <a href={action.implementationUrl} target="_blank" rel="noopener noreferrer nofollow" className="underline underline-offset-2">
                          {action.implementationUrl}
                        </a>
                      </dd>
                    </>
                  ) : null}
                  {action.notes ? (
                    <>
                      <dt className="mt-1 text-muted-foreground">Notes</dt>
                      <dd className="whitespace-pre-wrap">{action.notes}</dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
              <RecommendationControls
                status={rec.status}
                canEdit={can(access.role, "action:update")}
                defaultUrl={rec.targetUrl}
                plan={planAction.bind(null, orgSlug, projectId, rec.id)}
                setStatus={setRecommendationStatusAction.bind(null, orgSlug, projectId, rec.id)}
                implement={implementAction.bind(null, orgSlug, projectId, rec.id)}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Opportunity</CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2">
                <ImpactBadge score={rec.opportunity.impactScore} />
                {rec.opportunity.status === "RESOLVED" ? <span>No longer detected</span> : rec.opportunity.status === "DISMISSED" ? <span>Dismissed</span> : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 text-[13px]">
              <div className="font-medium">{rec.opportunity.title}</div>
              <p className="text-muted-foreground">{rec.opportunity.description}</p>
              {prompt ? (
                <Link href={`${base}/prompts/${prompt.id}`} className="underline underline-offset-2">
                  View the prompt&apos;s answers
                </Link>
              ) : null}
              {siblings.length ? (
                <div className="mt-2 border-t pt-2">
                  <div className="mb-1 text-xs text-muted-foreground">Also recommended</div>
                  <ul className="grid gap-1">
                    {siblings.map((s) => (
                      <li key={s.id}>
                        <Link href={`${base}/actions/${s.id}`} className="hover:underline">
                          {s.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
