import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getProjectPage } from "@/server/auth/session";
import { db } from "@/server/db";

export const metadata: Metadata = { title: "Competitors" };

export default async function CompetitorsPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  await getProjectPage(orgSlug, projectId);
  const competitors = await db.competitor.findMany({ where: { projectId, isActive: true }, orderBy: { createdAt: "asc" } });
  const edit = (
    <Button asChild variant="outline" size="sm">
      <Link href={`/${orgSlug}/onboarding/${projectId}/competitors`}>Edit competitors</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title="Competitors" description="Compare your AI visibility against competing brands." actions={competitors.length ? edit : undefined} />
      {competitors.length === 0 ? (
        <EmptyState icon={Users} title="No competitors yet" description="Add competitors so we can measure share of voice in AI answers." action={edit} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {competitors.map((c) => (
            <Card key={c.id} className="px-4 py-3.5">
              <div className="font-medium">{c.name}</div>
              <div className="text-[13px] text-muted-foreground">{c.domain ?? "No domain"}</div>
              <div className="mt-3 text-xs text-muted-foreground">Visibility appears after the first scan.</div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
