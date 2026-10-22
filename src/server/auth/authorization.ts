/**
 * Central authorization helpers. Every org- or project-scoped read/write in
 * the app must resolve access through these functions. They take an explicit
 * userId so they are framework-agnostic and testable.
 *
 * Non-members get NOT_FOUND (not FORBIDDEN) so resource existence is never
 * leaked across organizations.
 */
import { db } from "@/server/db";
import { AppError } from "@/lib/errors";
import type { OrgRole } from "@/generated/prisma/enums";
import { can, type Permission } from "./policy";

export interface OrgAccess {
  userId: string;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  role: OrgRole;
}

export interface ProjectAccess extends OrgAccess {
  projectId: string;
}

function assertPermission(role: OrgRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new AppError("FORBIDDEN", "You don't have permission to do that.");
  }
}

export async function requireOrgAccess(
  userId: string,
  org: { id: string } | { slug: string },
  permission: Permission = "org:read",
): Promise<OrgAccess> {
  const membership = await db.organizationMember.findFirst({
    where: { userId, organization: "id" in org ? { id: org.id } : { slug: org.slug } },
    select: { role: true, organization: { select: { id: true, slug: true, name: true } } },
  });
  if (!membership) throw new AppError("NOT_FOUND", "Organization not found.");
  assertPermission(membership.role, permission);
  return {
    userId,
    organizationId: membership.organization.id,
    organizationSlug: membership.organization.slug,
    organizationName: membership.organization.name,
    role: membership.role,
  };
}

export async function requireProjectAccess(
  userId: string,
  projectId: string,
  permission: Permission = "project:read",
): Promise<ProjectAccess> {
  const project = await db.project.findFirst({
    where: { id: projectId, archivedAt: null, organization: { members: { some: { userId } } } },
    select: {
      id: true,
      organization: {
        select: { id: true, slug: true, name: true, members: { where: { userId }, select: { role: true } } },
      },
    },
  });
  const role = project?.organization.members[0]?.role;
  if (!project || !role) throw new AppError("NOT_FOUND", "Project not found.");
  assertPermission(role, permission);
  return {
    userId,
    projectId: project.id,
    organizationId: project.organization.id,
    organizationSlug: project.organization.slug,
    organizationName: project.organization.name,
    role,
  };
}

export async function requirePlatformAdmin(userId: string): Promise<void> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true } });
  if (!user?.isPlatformAdmin) throw new AppError("NOT_FOUND", "Not found.");
}
