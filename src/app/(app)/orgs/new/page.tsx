import type { Metadata } from "next";
import { SimpleShell } from "@/components/layout/app-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSessionUser } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { CreateOrgForm } from "./create-org-form";

export const metadata: Metadata = { title: "New organization" };

export default async function NewOrgPage() {
  const user = await requireSessionUser();
  const orgs = await listOrganizationsForUser(user.id);
  return (
    <SimpleShell user={user} orgs={orgs}>
      <Card className="mx-auto max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Create an organization</CardTitle>
          <CardDescription>Organizations hold projects, team members and billing.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateOrgForm />
        </CardContent>
      </Card>
    </SimpleShell>
  );
}
