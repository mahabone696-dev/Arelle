/**
 * Role-based permission policy. Pure and synchronous so it can be unit tested
 * and reused by the worker. All org-scoped checks go through `can()`.
 */
import type { OrgRole } from "@/generated/prisma/enums";

export type Permission =
  | "org:read"
  | "org:update"
  | "org:delete"
  | "members:manage"
  | "billing:manage"
  | "project:read"
  | "project:create"
  | "project:update"
  | "project:delete"
  | "scan:run"
  | "action:update"
  | "report:share";

const VIEWER: readonly Permission[] = ["org:read", "project:read"];
const MEMBER: readonly Permission[] = [...VIEWER, "project:create", "project:update", "scan:run", "action:update", "report:share"];
const ADMIN: readonly Permission[] = [...MEMBER, "org:update", "members:manage", "project:delete"];
const OWNER: readonly Permission[] = [...ADMIN, "org:delete", "billing:manage"];

const ROLE_PERMISSIONS: Record<OrgRole, ReadonlySet<Permission>> = {
  VIEWER: new Set(VIEWER),
  MEMBER: new Set(MEMBER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

const ROLE_RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function can(role: OrgRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isRoleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}
