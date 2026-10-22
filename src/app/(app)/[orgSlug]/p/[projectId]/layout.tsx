import { ProjectShell } from "@/components/layout/app-shell";
import { getProjectPage } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { listProjects } from "@/server/projects/service";

export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
  children: React.ReactNode;
}) {
  const { orgSlug, projectId } = await params;
  const { user, access } = await getProjectPage(orgSlug, projectId);
  const [orgs, projects] = await Promise.all([listOrganizationsForUser(user.id), listProjects(user.id, access.organizationId)]);
  const isDemo = orgs.find((o) => o.slug === orgSlug)?.isDemo ?? false;
  return (
    <ProjectShell user={user} orgs={orgs} orgSlug={orgSlug} projects={projects} projectId={projectId} isDemo={isDemo}>
      {children}
    </ProjectShell>
  );
}
