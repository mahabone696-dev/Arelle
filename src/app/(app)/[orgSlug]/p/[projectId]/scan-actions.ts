"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/server/auth/session";
import { requireProjectAccess } from "@/server/auth/authorization";
import { createScan } from "@/server/scans/service";
import { AppError, type ActionResult } from "@/lib/errors";
import { toActionError } from "@/lib/action-result";

export async function runScanAction(orgSlug: string, projectId: string): Promise<ActionResult<{ scanId: string }>> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session has expired. Sign in again." };
  try {
    const access = await requireProjectAccess(user.id, projectId, "scan:run");
    if (access.organizationSlug !== orgSlug) throw new AppError("NOT_FOUND", "Project not found.");
    const scan = await createScan(user.id, projectId);
    revalidatePath(`/${orgSlug}/p/${projectId}`);
    return { ok: true, data: { scanId: scan.id } };
  } catch (error) {
    return toActionError(error);
  }
}
