import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Flag } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { ImpactBadge, OPPORTUNITY_LABELS, RecommendationStatusBadge } from "@/components/actions/labels";
import { OpportunityStatusButton } from "@/components/actions/recommendation-controls";
import { hasFeature } from "@/server/billing/limits";
import { getProjectPage } from "@/server/auth/session";
import { can } from "@/server/auth/policy";
import { listOpportunities, opportunityCounts } from "@/server/opportunities/service";
import type { OpportunityEvidence } from "@/server/opportunities/rules";
import type { OpportunityStatus, OpportunityType } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import { setOpportunityStatusAction } from "../action-engine-actions";

export const metadata: Metadata = { title: "Opportunities" };

const TABS: { status: OpportunityStatus; label: string; hint: string }[] = [
  { status: "OPEN", label: "Open", hint: "Detected in the last 30 days of answers." },
  { status: "RESOLVED", label: "No longer detected", hint: "Recent answers no longer show this pattern. This is an observation, not proof that a change caused it." },
  { status: "DISMISSED", label: "Dismissed", hint: "Hidden by your team. Still re-checked after each scan." },
];
const TYPES = Object.keys(OPPORTUNITY_LABELS) as OpportunityType[];

function evidenceFacts(e: OpportunityEvidence, type: OpportunityType): string[] {
  const facts = [`${e.answers} answers`];
  if (e.enginesLosing !== undefined && e.engines) facts.push(`absent in ${e.enginesLosing} of ${e.engines} engines' latest answers`);
  if (e.leader && type !== "COMPETITOR_DOMINANCE") facts.push(`${e.leader.name} leads (${e.leader.score.toFixed(1)})`);
  if (e.potentialGain) facts.push(`gap ≈ ${e.potentialGain.toFixed(1)} pts of your overall score`);
  if (e.averagePosition) facts.push(`your avg. position ${e.averagePosition.toFixed(1)}`);
  if (e.prompts && type !== "CITATION_GAP") facts.push(`${e.prompts} prompts`);
  if (type === "CITATION_GAP" && e.prompts) facts.push(`influences ${e.prompts} prompts`);
  if (e.gapScore !== undefined) facts.push(`gap score ${e.gapScore}`);
  return facts;
}

export default async function OpportunitiesPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string }>; searchParams: Promise<{ status?: string; type?: string }> }) {
  const [{ orgSlug, projectId }, sp] = await Promise.all([params, searchParams]);
  const { user, access } = await getProjectPage(orgSlug, projectId);
  const status = TABS.some((t) => t.status === sp.status) ? (sp.status as OpportunityStatus) : "OPEN";
  const type = TYPES.includes(sp.type as OpportunityType) ? (sp.type as OpportunityType) : undefined;
  const [items, counts, actionEngine] = await Promise.all([listOpportunities(user.id, projectId, { status, type }), opportunityCounts(user.id, projectId), hasFeature(access.organizationId, "actionEngine")]);
  const base = `/${orgSlug}/p/${projectId}`;
  const canEdit = can(access.role, "action:update");
  const href = (s: OpportunityStatus, t?: OpportunityType) => `${base}/opportunities?status=${s}${t ? `&type=${t}` : ""}`;
  const tab = TABS.find((t) => t.status === status)!;

  return (
    <>
      <PageHeader title="Opportunities" description="Where AI answers favour competitors, found automatically after each scan. Ordered by impact score — a priority signal, not a forecast." />
      <nav aria-label="Opportunity status" className="mb-3 flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.status}
            href={href(t.status, type)}
            aria-current={t.status === status ? "page" : undefined}
            className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px]", t.status === status ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
          >
            {t.label} <span className="tabular text-muted-foreground">{counts[t.status] ?? 0}</span>
          </Link>
        ))}
      </nav>
      <div className="mb-4 flex flex-wrap items-center gap-1.5 text-xs">
        <Link href={href(status)} className={cn("rounded-full border px-2.5 py-1", !type ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>
          All types
        </Link>
        {TYPES.map((t) => (
          <Link key={t} href={href(status, t)} className={cn("whitespace-nowrap rounded-full border px-2.5 py-1", type === t ? "border-foreground bg-foreground text-background" : "hover:bg-accent")}>
            {OPPORTUNITY_LABELS[t]}
          </Link>
        ))}
      </div>
      <p className="mb-4 text-[13px] text-muted-foreground">{tab.hint}</p>

      {items.length === 0 ? (
        <EmptyState icon={Flag} title={status === "OPEN" ? "No open opportunities" : "Nothing here"} description={status === "OPEN" ? "Opportunities are detected from the last 30 days of analyzed answers after each scan." : "Try another tab or type."} />
      ) : (
        <div className="grid gap-3">
          {items.map((o) => {
            const e = o.evidence as unknown as OpportunityEvidence;
            return (
              <Card key={o.id} className="min-w-0 px-5 py-4">
                <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <ImpactBadge score={o.impactScore} />
                      <span>{OPPORTUNITY_LABELS[o.type]}</span>
                      <span>· confidence {Math.round(o.confidenceScore * 100)}%</span>
                    </div>
                    <h2 className="text-sm font-medium">{o.title}</h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">{o.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {evidenceFacts(e, o.type).join(" · ")}
                      {o.prompt ? (
                        <>
                          {" · "}
                          <Link href={`${base}/prompts/${o.prompt.id}`} className="underline underline-offset-2 hover:text-foreground">
                            View prompt
                          </Link>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <OpportunityStatusButton status={o.status} canEdit={canEdit} setStatus={setOpportunityStatusAction.bind(null, orgSlug, projectId, o.id)} />
                </div>
                {!actionEngine && o.recommendations.length ? (
                  <p className="mt-3 border-t pt-2 text-[13px] text-muted-foreground">
                    {o.recommendations.length} recommendation{o.recommendations.length === 1 ? "" : "s"} ready —{" "}
                    <Link href={`/${orgSlug}/billing`} className="font-medium text-foreground underline underline-offset-2">
                      available on Growth
                    </Link>
                  </p>
                ) : o.recommendations.length ? (
                  <ul className="mt-3 divide-y border-t text-[13px]">
                    {o.recommendations.map((r) => (
                      <li key={r.id}>
                        <Link href={`${base}/actions/${r.id}`} className="flex items-center gap-3 py-2 hover:text-foreground">
                          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1">{r.title}</span>
                          <RecommendationStatusBadge status={r.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : e.coveredBy?.length ? (
                  <p className="mt-3 border-t pt-2 text-[13px] text-muted-foreground">Covered by the recommendations for “{e.coveredBy.map((c) => c.title).join("”, “")}”.</p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
