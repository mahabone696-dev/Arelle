import { db } from "@/server/db";
import { requireOrgAccess } from "@/server/auth/authorization";

export async function listOrganizationMembers(userId: string, organizationId: string) {
  const access = await requireOrgAccess(userId, { id: organizationId }, "org:read");
  return db.organizationMember.findMany({
    where: { organizationId: access.organizationId },
    select: { id: true, role: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });
}
