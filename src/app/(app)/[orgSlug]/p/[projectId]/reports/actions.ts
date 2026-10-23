"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/server/auth/session";
import { requireProjectAccess } from "@/server/auth/authorization";
import { createShareLink, revokeShareLink } from "@/server/reports/service";
import { appOrigin } from "@/lib/signup-policy";
import { AppError, type ActionResult } from "@/lib/errors";
import { toActionError } from "@/lib/action-result";

async function guard(orgSlug: string, projectId: string) {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
  const access = await requireProjectAccess(user.id, projectId, "report:share");
  if (access.organizationSlug !== orgSlug) throw new AppError("NOT_FOUND", "Project not found.");
  return user;
}

export async function createShareAction(orgSlug: string, projectId: string, _prev: ActionResult<{ url: string }> | null, form: FormData): Promise<ActionResult<{ url: string }>> {
  const values = Object.fromEntries(["title", "range", "expiresInDays", "agencyName", "accentColor"].map((k) => [k, String(form.get(k) ?? "")]));
  try {
    const user = await guard(orgSlug, projectId);
    const link = await createShareLink(user.id, projectId, values);
    revalidatePath(`/${orgSlug}/p/${projectId}/reports`);
    return { ok: true, data: { url: `${appOrigin()}${link.path}` } };
  } catch (error) {
    return toActionError(error, values);
  }
}

export async function revokeShareAction(orgSlug: string, projectId: string, shareId: string): Promise<ActionResult> {
  try {
    const user = await guard(orgSlug, projectId);
    await revokeShareLink(user.id, projectId, shareId);
    revalidatePath(`/${orgSlug}/p/${projectId}/reports`);
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error);
  }
}
