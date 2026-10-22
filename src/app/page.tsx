import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";

export default async function Home() {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  const orgs = await listOrganizationsForUser(user.id);
  const first = orgs.find((o) => !o.isDemo) ?? orgs[0];
  redirect(first ? `/${first.slug}` : "/orgs/new");
}
