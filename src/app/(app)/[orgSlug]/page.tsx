import Link from "next/link";
import { redirect } from "next/navigation";
import { Globe } from "lucide-react";
import { SimpleShell } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { requireOrgPage } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { listProjects } from "@/server/projects/service";

export default async function OrgHomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const { user, access } = await requireOrgPage(orgSlug);
  const projects = await listProjects(user.id, access.organizationId);
  if (projects[0]) redirect(`/${orgSlug}/p/${projects[0].id}`);

  const orgs = await listOrganizationsForUser(user.id);
  return (
    <SimpleShell user={user} orgs={orgs} orgSlug={orgSlug}>
      <EmptyState
        icon={Globe}
        title="Add your first website"
        description="Create a project for the brand and domain you want to improve in AI search. You can track competitors and prompts per project."
        action={
          <Button asChild>
            <Link href={`/${orgSlug}/projects/new`}>Create project</Link>
          </Button>
        }
        className="bg-background"
      />
    </SimpleShell>
  );
}
