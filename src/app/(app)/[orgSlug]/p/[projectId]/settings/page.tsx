import type { Metadata } from "next";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getProjectPage } from "@/server/auth/session";
import { listOrganizationMembers } from "@/server/organizations/members";
import { countryName, languageName } from "@/lib/i18n";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { user, project, access } = await getProjectPage(orgSlug, projectId);
  const members = await listOrganizationMembers(user.id, access.organizationId);

  const rows: Array<[string, string]> = [
    ["Name", project.name],
    ["Domain", project.domain],
    ["Primary market", countryName(project.country)],
    ["Language", languageName(project.language)],
    ["Locale", project.locale],
    ["Timezone", project.timezone],
  ];

  return (
    <>
      <PageHeader title="Settings" description="Project configuration and organization members." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Project</CardTitle>
            <CardDescription>Market and language settings apply to new prompts and scans.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y text-sm">
              {rows.map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-2.5">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>{access.organizationName}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.user.name ?? m.user.email}</div>
                    <div className="truncate text-xs text-muted-foreground">{m.user.email}</div>
                  </div>
                  <Badge variant="outline">{m.role}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
