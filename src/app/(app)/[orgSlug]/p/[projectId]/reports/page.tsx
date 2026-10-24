import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UpgradeCard } from "@/components/billing/upgrade-card";
import { getProjectPage } from "@/server/auth/session";
import { can } from "@/server/auth/policy";
import { listShareLinks } from "@/server/reports/service";
import { createShareAction, revokeShareAction } from "./actions";
import { RevokeButton, ShareForm } from "./share-form";

export const metadata: Metadata = { title: "Reports" };

const date = (d: Date) => d.toISOString().slice(0, 10);
const STATUS = { ACTIVE: "success", EXPIRED: "outline", REVOKED: "default" } as const;

export default async function ReportsPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { user, access } = await getProjectPage(orgSlug, projectId);
  const { entitled, enabled, links } = await listShareLinks(user.id, projectId);
  const base = `/${orgSlug}/p/${projectId}`;
  const canShare = can(access.role, "report:share");

  return (
    <>
      <PageHeader
        title="Reports"
        description="A read-only visibility report you can share with clients or colleagues."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/reports/preview`}>Preview report</Link>
          </Button>
        }
      />
      {!enabled ? (
        <p className="rounded-lg border bg-card px-5 py-4 text-[13px] text-muted-foreground">Report sharing is turned off on this deployment. Existing links are paused. You can still preview the report.</p>
      ) : !entitled ? (
        <UpgradeCard orgSlug={orgSlug} title="Share links are on the Agency plan" description="Send clients a live, read-only report with visibility, trend, competitors, winning and losing prompts, citation gaps, opportunities and completed actions. You can preview the report on any plan." />
      ) : (
        <div className="grid gap-4">
          {canShare ? (
            <Card>
              <CardHeader>
                <CardTitle>New share link</CardTitle>
                <CardDescription>The report shows live data for the chosen period. Links can expire and be turned off at any time.</CardDescription>
              </CardHeader>
              <CardContent>
                <ShareForm action={createShareAction.bind(null, orgSlug, projectId)} />
              </CardContent>
            </Card>
          ) : null}
          <Card className="overflow-x-auto">
            <CardHeader className="pb-4">
              <CardTitle>Share links</CardTitle>
            </CardHeader>
            {links.length ? (
              <table className="w-full min-w-[640px] text-[13px]">
                <thead className="whitespace-nowrap border-y text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-2 font-medium">Report</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Views</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                    <th className="px-3 py-2 font-medium">Expires</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {links.map((l) => (
                    <tr key={l.id}>
                      <td className="px-5 py-2">
                        <div className="font-medium">{l.title || "AI visibility report"}</div>
                        <div className="text-xs text-muted-foreground">
                          {l.range}
                          {l.branding.agencyName ? ` · prepared by ${l.branding.agencyName}` : ""}
                          {l.createdBy ? ` · by ${l.createdBy.name ?? l.createdBy.email}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={STATUS[l.status]}>{l.status.toLowerCase()}</Badge>
                      </td>
                      <td className="tabular px-3 py-2 text-right">{l.viewCount}</td>
                      <td className="tabular whitespace-nowrap px-3 py-2">{date(l.createdAt)}</td>
                      <td className="tabular whitespace-nowrap px-3 py-2">{l.expiresAt ? date(l.expiresAt) : "never"}</td>
                      <td className="px-5 py-2 text-right">{l.status === "ACTIVE" && canShare ? <RevokeButton revoke={revokeShareAction.bind(null, orgSlug, projectId, l.id)} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-5 pb-5 text-[13px] text-muted-foreground">No share links yet.</p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
