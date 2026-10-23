import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/server/auth/session";
import { markAuditConverted } from "@/server/audit/service";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { db } from "@/server/db";

/**
 * After sign-up (or sign-in) from an audit: record the conversion and open
 * onboarding with the audited website prefilled.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  const to = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl));
  if (!user) return to(`/sign-up?audit=${encodeURIComponent(id)}`);
  const domain = await markAuditConverted(id, user.id);
  const orgs = await listOrganizationsForUser(user.id);
  const org = orgs.find((o) => !o.isDemo);
  if (!domain || !org) return to("/");
  const audit = await db.publicAudit.findUnique({ where: { id }, select: { result: true } });
  const country = (audit?.result as { country?: string } | null)?.country ?? "US";
  return to(`/${org.slug}/onboarding?url=${encodeURIComponent(domain)}&country=${encodeURIComponent(country)}`);
}
