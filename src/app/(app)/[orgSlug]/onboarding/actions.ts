"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionUser } from "@/server/auth/session";
import { requireOrgAccess, requireProjectAccess } from "@/server/auth/authorization";
import {
  generatePrompts,
  runWebsiteAnalysis,
  saveBrandProfile,
  saveCompetitors,
  savePromptReview,
  startOnboarding,
  suggestCompetitors,
} from "@/server/onboarding/service";
import { AppError, formValues, type ActionResult } from "@/lib/errors";
import { toActionError } from "@/lib/action-result";

const listField = z.string().transform((s, ctx) => {
  try {
    const parsed = JSON.parse(s || "[]");
    return z.array(z.string()).parse(parsed);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid list" });
    return z.NEVER;
  }
});

async function sessionUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user.id;
}

/** Confirms the project belongs to the org in the URL before any mutation. */
async function projectInOrg(userId: string, orgSlug: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  if (access.organizationSlug !== orgSlug) throw new AppError("NOT_FOUND", "Project not found.");
  return access;
}

const base = (orgSlug: string, projectId: string) => `/${orgSlug}/onboarding/${projectId}`;

export async function startOnboardingAction(orgSlug: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = await sessionUserId();
  const values = formValues(formData);
  let projectId: string;
  try {
    const access = await requireOrgAccess(userId, { slug: orgSlug }, "project:create");
    const result = await startOnboarding(userId, access.organizationId, {
      url: String(formData.get("url") ?? ""),
      country: String(formData.get("country") ?? ""),
      language: String(formData.get("language") ?? ""),
      timezone: String(formData.get("timezone") || "UTC"),
    });
    projectId = result.projectId;
  } catch (error) {
    return toActionError(error, values);
  }
  // Failed analyses still continue to the brand step, which explains the failure and allows manual entry.
  redirect(`${base(orgSlug, projectId)}/brand`);
}

export async function reanalyzeAction(orgSlug: string, projectId: string): Promise<ActionResult> {
  const userId = await sessionUserId();
  try {
    await projectInOrg(userId, orgSlug, projectId);
    await runWebsiteAnalysis(userId, projectId);
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`${base(orgSlug, projectId)}/brand`);
  return { ok: true, data: undefined };
}

export async function saveBrandAction(orgSlug: string, projectId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = await sessionUserId();
  const values = formValues(formData);
  try {
    await projectInOrg(userId, orgSlug, projectId);
    const lists = z.object({ products: listField, services: listField, targetCustomers: listField, markets: listField, topics: listField, aliases: listField }).parse({
      products: formData.get("products"),
      services: formData.get("services"),
      targetCustomers: formData.get("targetCustomers"),
      markets: formData.get("markets"),
      topics: formData.get("topics"),
      aliases: formData.get("aliases"),
    });
    await saveBrandProfile(userId, projectId, {
      brandName: String(formData.get("brandName") ?? ""),
      industry: String(formData.get("industry") ?? ""),
      description: String(formData.get("description") ?? ""),
      ...lists,
    });
    // First visit: fetch AI suggestions now so the next screen is ready. No-op if competitors exist.
    await suggestCompetitors(userId, projectId);
  } catch (error) {
    return toActionError(error, values);
  }
  redirect(`${base(orgSlug, projectId)}/competitors`);
}

export async function regenerateCompetitorsAction(orgSlug: string, projectId: string): Promise<ActionResult<{ method: string }>> {
  const userId = await sessionUserId();
  try {
    await projectInOrg(userId, orgSlug, projectId);
    const res = await suggestCompetitors(userId, projectId, undefined, { replace: true });
    revalidatePath(`${base(orgSlug, projectId)}/competitors`);
    return { ok: true, data: { method: res.method } };
  } catch (error) {
    return toActionError(error);
  }
}

export async function saveCompetitorsAction(orgSlug: string, projectId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = await sessionUserId();
  try {
    await projectInOrg(userId, orgSlug, projectId);
    await saveCompetitors(userId, projectId, JSON.parse(String(formData.get("payload") ?? "[]")));
    await generatePrompts(userId, projectId);
  } catch (error) {
    return toActionError(error);
  }
  redirect(`${base(orgSlug, projectId)}/prompts`);
}

export async function regeneratePromptsAction(orgSlug: string, projectId: string): Promise<ActionResult> {
  const userId = await sessionUserId();
  try {
    await projectInOrg(userId, orgSlug, projectId);
    await generatePrompts(userId, projectId, undefined, { replace: true });
  } catch (error) {
    return toActionError(error);
  }
  revalidatePath(`${base(orgSlug, projectId)}/prompts`);
  return { ok: true, data: undefined };
}

export async function savePromptsAction(orgSlug: string, projectId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const userId = await sessionUserId();
  const finish = formData.get("intent") === "finish";
  try {
    await projectInOrg(userId, orgSlug, projectId);
    const payload = JSON.parse(String(formData.get("payload") ?? "{}"));
    await savePromptReview(userId, projectId, { ...payload, finish });
  } catch (error) {
    return toActionError(error);
  }
  if (finish) redirect(`/${orgSlug}/p/${projectId}?onboarded=1`);
  // The review list remounts with fresh ids after saving; carry the confirmation in the URL.
  redirect(`${base(orgSlug, projectId)}/prompts?saved=${Date.now()}`);
}
