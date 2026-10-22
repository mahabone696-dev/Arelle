"use server";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { requireOrgAccess } from "@/server/auth/authorization";
import { createProject } from "@/server/projects/service";
import { createProjectSchema } from "@/server/projects/schemas";
import { formValues, isAppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function createProjectAction(orgSlug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session has expired. Sign in again." };

  const values = formValues(formData);
  const parsed = createProjectSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.error.flatten().fieldErrors, values };

  let projectId: string;
  try {
    const access = await requireOrgAccess(user.id, { slug: orgSlug }, "project:create");
    const project = await createProject(user.id, access.organizationId, parsed.data);
    projectId = project.id;
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, values };
    logger.error("project.create_failed", { error });
    return { ok: false, error: "Could not create the project. Please try again.", values };
  }
  redirect(`/${orgSlug}/p/${projectId}`);
}
