"use server";

import { revalidatePath } from "next/cache";
import { requireSessionUser } from "@/server/auth/session";
import { adminSetKillSwitch, adminSetProviderEnabled } from "@/server/admin/service";
import { formValues, isAppError, type ActionResult } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function killSwitchAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const user = await requireSessionUser();
  try {
    await adminSetKillSwitch(user.id, Object.fromEntries(form));
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, values: formValues(form) };
    logger.error("admin.kill_switch_failed", { error });
    return { ok: false, error: "Couldn't change the kill switch.", values: formValues(form) };
  }
  revalidatePath("/admin");
  return { ok: true, data: undefined };
}

export async function providerToggleAction(slug: string, enabled: boolean): Promise<void> {
  const user = await requireSessionUser();
  await adminSetProviderEnabled(user.id, slug, enabled);
  revalidatePath("/admin");
}
