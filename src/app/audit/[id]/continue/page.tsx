import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { markAuditConverted } from "@/server/audit/service";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * After sign-up (or sign-in) from an audit: record the conversion and open
 * onboarding with the audited website prefilled. A page (not a route handler)
 * so the client-side redirect after sign-up follows it.
 */
export default async function ContinueFromAudit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect(`/sign-up?audit=${encodeURIComponent(id)}`);
  const domain = await markAuditConverted(id, user.id);
  const org = (await listOrganizationsForUser(user.id)).find((o) => !o.isDemo);
  if (!domain || !org) redirect("/");
  const audit = await db.publicAudit.findUnique({ where: { id }, select: { result: true } });
  const country = (audit?.result as { country?: string } | null)?.country ?? "US";
  redirect(`/${org.slug}/onboarding?url=${encodeURIComponent(domain)}&country=${encodeURIComponent(country)}`);
}
