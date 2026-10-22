/**
 * Next.js-facing session helpers for server components and server actions.
 */
import "server-only";
import { cache } from "react";
import { redirect, notFound } from "next/navigation";
import { auth } from "./index";
import { requireOrgAccess, requireProjectAccess, type OrgAccess, type ProjectAccess } from "./authorization";
import type { Permission } from "./policy";
import { isAppError } from "@/lib/errors";
import { db } from "@/server/db";

export interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
}

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const session = await auth();
  const user = session?.user;
  if (!user?.id) return null;
  return { id: user.id, email: user.email ?? null, name: user.name ?? null, image: user.image ?? null };
});

/** For pages: redirect anonymous users to sign-in. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}

/** For pages: resolve org access or render 404. */
export async function requireOrgPage(orgSlug: string, permission?: Permission): Promise<{ user: SessionUser; access: OrgAccess }> {
  const user = await requireSessionUser();
  try {
    return { user, access: await requireOrgAccess(user.id, { slug: orgSlug }, permission) };
  } catch (error) {
    if (isAppError(error)) notFound();
    throw error;
  }
}

/** For pages: resolve project access (and that it belongs to orgSlug) or render 404. */
export async function requireProjectPage(
  orgSlug: string,
  projectId: string,
  permission?: Permission,
): Promise<{ user: SessionUser; access: ProjectAccess }> {
  const user = await requireSessionUser();
  try {
    const access = await requireProjectAccess(user.id, projectId, permission);
    if (access.organizationSlug !== orgSlug) notFound();
    return { user, access };
  } catch (error) {
    if (isAppError(error)) notFound();
    throw error;
  }
}

/**
 * For project pages and their layout: resolves access plus the project row.
 * Cached per request so the layout and page (rendered in parallel) share one
 * authorization result, and both render 404 on denial.
 */
export const getProjectPage = cache(async (orgSlug: string, projectId: string) => {
  const { user, access } = await requireProjectPage(orgSlug, projectId);
  const project = await db.project.findUniqueOrThrow({
    where: { id: access.projectId },
    select: { id: true, name: true, domain: true, country: true, language: true, locale: true, timezone: true, createdAt: true, onboardingStep: true, onboardingCompletedAt: true },
  });
  return { user, access, project };
});
