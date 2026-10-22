import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getProjectPage } from "@/server/auth/session";
import { db } from "@/server/db";
import { INTENT_LABELS } from "@/server/onboarding/intents";

export const metadata: Metadata = { title: "Prompts" };

export default async function PromptsPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  await getProjectPage(orgSlug, projectId);
  const prompts = await db.prompt.findMany({
    where: { projectId, isActive: true },
    include: { cluster: { select: { name: true } } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  const edit = (
    <Button asChild variant="outline" size="sm">
      <Link href={`/${orgSlug}/onboarding/${projectId}/prompts`}>Edit prompts</Link>
    </Button>
  );
  return (
    <>
      <PageHeader title="Prompts" description="Track the questions your customers ask AI engines." actions={prompts.length ? edit : undefined} />
      {prompts.length === 0 ? (
        <EmptyState icon={MessageSquareText} title="No prompts yet" description="Approve prompts during setup to start tracking them." action={edit} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2.5 font-medium">Prompt</th>
                <th className="px-4 py-2.5 font-medium">Intent</th>
                <th className="px-4 py-2.5 font-medium">Cluster</th>
                <th className="px-4 py-2.5 text-right font-medium">Priority</th>
                <th className="px-4 py-2.5 text-right font-medium">Visibility</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {prompts.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2.5 font-medium">{p.text}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant="outline">{INTENT_LABELS[p.intent].label}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{p.cluster?.name ?? "—"}</td>
                  <td className="tabular px-4 py-2.5 text-right">P{p.priority}</td>
                  <td className="tabular px-4 py-2.5 text-right text-muted-foreground" title="Available after the first scan">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
