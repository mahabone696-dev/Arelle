import type { Metadata } from "next";
import { SimpleShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrgPage } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { CreateProjectForm } from "./create-project-form";
import { createProjectAction } from "./actions";

export const metadata: Metadata = { title: "New project" };

export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const { user } = await requireOrgPage(orgSlug, "project:create");
  const orgs = await listOrganizationsForUser(user.id);
  return (
    <SimpleShell user={user} orgs={orgs} orgSlug={orgSlug}>
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">New project</CardTitle>
          <CardDescription>A project tracks one brand and its primary domain across AI engines.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm action={createProjectAction.bind(null, orgSlug)} />
        </CardContent>
      </Card>
    </SimpleShell>
  );
}
