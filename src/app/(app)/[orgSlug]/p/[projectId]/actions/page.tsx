import type { Metadata } from "next";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui/card";
import { Delta, num1 } from "@/components/dashboard/delta";
import { ImpactBadge, RECOMMENDATION_LABELS } from "@/components/actions/labels";
import { getProjectPage } from "@/server/auth/session";
import { listRecommendations } from "@/server/opportunities/service";
import type { RecommendationStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Actions" };

type Rec = Awaited<ReturnType<typeof listRecommendations>>[number];

const GROUPS: { status: RecommendationStatus; title: string; empty: string }[] = [
  { status: "IMPLEMENTED", title: "Implemented", empty: "Mark a recommendation as implemented to start tracking the observed change." },
  { status: "PLANNED", title: "Planned", empty: "Nothing planned yet." },
  { status: "OPEN", title: "Recommended", empty: "No open recommendations." },
];

const date = (d: Date) => d.toISOString().slice(0, 10);

function Row({ r, base }: { r: Rec; base: string }) {
  const action = r.actions[0];
  const m = action?.measurements[0];
  return (
    <li>
      <Link href={`${base}/actions/${r.id}`} className="grid gap-1 px-5 py-3 hover:bg-accent/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ImpactBadge level={r.estimatedImpact} />
            <span>{RECOMMENDATION_LABELS[r.type]}</span>
            {r.opportunity.prompt ? <span className="truncate">· “{r.opportunity.prompt.text}”</span> : null}
          </div>
          <div className="mt-1 text-[13px] font-medium">{r.title}</div>
        </div>
        <div className="text-xs text-muted-foreground sm:text-right">
          {r.status === "IMPLEMENTED" && action?.implementedAt ? (
            m ? (
              <span className="inline-flex flex-wrap items-baseline gap-x-2 sm:justify-end">
                <span className="tabular">
                  {num1(m.beforeScore)} → <span className="font-medium text-foreground">{num1(m.afterScore)}</span>
                </span>
                <Delta value={m.delta} />
                <span>observed {m.daysSinceImplementation} days after</span>
              </span>
            ) : (
              <span>Implemented {date(action.implementedAt)} · waiting for the next scan</span>
            )
          ) : r.status === "PLANNED" && action ? (
            <span>Planned {date(action.plannedAt)}</span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

export default async function ActionsPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { user } = await getProjectPage(orgSlug, projectId);
  const all = await listRecommendations(user.id, projectId);
  const base = `/${orgSlug}/p/${projectId}`;
  // Open recommendations only for opportunities still detected; anything acted on always stays visible.
  const visible = all.filter((r) => r.status !== "OPEN" || r.opportunity.status === "OPEN");
  const dismissed = visible.filter((r) => r.status === "DISMISSED").length;

  if (!visible.length) {
    return (
      <>
        <PageHeader title="Actions" description="Recommended work and its observed impact over time." />
        <EmptyState icon={ListChecks} title="No recommendations yet" description="Recommendations are generated with opportunities after each scan." />
      </>
    );
  }
  return (
    <>
      <PageHeader title="Actions" description="Recommended work and the visibility change observed after you implement it." />
      <div className="grid gap-4">
        {GROUPS.map((g) => {
          const rows = visible.filter((r) => r.status === g.status);
          return (
            <Card key={g.status} className="overflow-hidden">
              <div className="flex items-baseline justify-between border-b px-5 py-3">
                <h2 className="text-sm font-medium">{g.title}</h2>
                <span className="tabular text-xs text-muted-foreground">{rows.length}</span>
              </div>
              {rows.length ? (
                <ul className="divide-y">
                  {rows.map((r) => (
                    <Row key={r.id} r={r} base={base} />
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-4 text-[13px] text-muted-foreground">{g.empty}</p>
              )}
            </Card>
          );
        })}
        <p className="text-xs text-muted-foreground">
          Observed changes compare your visibility before and after implementation. Many things affect AI answers (engine updates, competitor activity, seasonality), so a change isn&apos;t proof the action caused it.
          {dismissed ? ` ${dismissed} dismissed recommendation${dismissed === 1 ? " is" : "s are"} hidden.` : ""}
        </p>
      </div>
    </>
  );
}
