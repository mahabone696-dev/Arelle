import { redirect } from "next/navigation";
import { Globe } from "lucide-react";
import { SimpleShell } from "@/components/layout/app-shell";
import { EmptyState } from "@/components/empty-state";
import { requireOrgPage } from "@/server/auth/session";
import { can } from "@/server/auth/policy";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { listProjects } from "@/server/projects/service";

export default async function OrgHomePage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const { user, access } = await requireOrgPage(orgSlug);
  const projects = await listProjects(user.id, access.organizationId);
  if (projects[0]) redirect(`/${orgSlug}/p/${projects[0].id}`);
  if (can(access.role, "project:create")) redirect(`/${orgSlug}/onboarding`);

  // Viewers can't create projects; explain instead of sending them to a form they can't use.
  const orgs = await listOrganizationsForUser(user.id);
  return (
    <SimpleShell user={user} orgs={orgs} orgSlug={orgSlug}>
      <EmptyState
        icon={Globe}
        title="No projects yet"
        description="An organization member with edit access needs to add the first website."
        className="bg-background"
      />
    </SimpleShell>
  );
}
