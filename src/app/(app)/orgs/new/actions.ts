"use server";

import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth/session";
import { createOrganization } from "@/server/organizations/service";
import { createOrganizationSchema } from "@/server/organizations/schemas";
import { formValues, type ActionResult } from "@/lib/errors";

export async function createOrganizationAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "Your session has expired. Sign in again." };
  const parsed = createOrganizationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, error: "Check the highlighted fields.", fieldErrors: parsed.error.flatten().fieldErrors, values: formValues(formData) };
  const org = await createOrganization(user.id, parsed.data);
  redirect(`/${org.slug}`);
}
