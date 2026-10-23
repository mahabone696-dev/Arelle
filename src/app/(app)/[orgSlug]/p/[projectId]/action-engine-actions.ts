"use server";

import { revalidatePath } from "next/cache";
import { getSessionUser } from "@/server/auth/session";
import { requireProjectAccess } from "@/server/auth/authorization";
import { implementRecommendation, planRecommendation, setOpportunityStatus, setRecommendationStatus } from "@/server/opportunities/service";
import { AppError, type ActionResult } from "@/lib/errors";
import { toActionError } from "@/lib/action-result";

async function guard(orgSlug: string, projectId: string) {
  const user = await getSessionUser();
  if (!user) throw new AppError("UNAUTHENTICATED", "Your session has expired. Sign in again.");
  const access = await requireProjectAccess(user.id, projectId, "action:update");
  if (access.organizationSlug !== orgSlug) throw new AppError("NOT_FOUND", "Project not found.");
  return user;
}

const refresh = (orgSlug: string, projectId: string) => revalidatePath(`/${orgSlug}/p/${projectId}`, "layout");

export async function planAction(orgSlug: string, projectId: string, recommendationId: string): Promise<ActionResult> {
  try {
    const user = await guard(orgSlug, projectId);
    await planRecommendation(user.id, projectId, recommendationId);
    refresh(orgSlug, projectId);
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error);
  }
}

export async function setRecommendationStatusAction(orgSlug: string, projectId: string, recommendationId: string, status: "OPEN" | "DISMISSED"): Promise<ActionResult> {
  try {
    const user = await guard(orgSlug, projectId);
    await setRecommendationStatus(user.id, projectId, recommendationId, status);
    refresh(orgSlug, projectId);
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error);
  }
}

export async function setOpportunityStatusAction(orgSlug: string, projectId: string, opportunityId: string, status: "OPEN" | "DISMISSED"): Promise<ActionResult> {
  try {
    const user = await guard(orgSlug, projectId);
    await setOpportunityStatus(user.id, projectId, opportunityId, status);
    refresh(orgSlug, projectId);
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error);
  }
}

export async function implementAction(orgSlug: string, projectId: string, recommendationId: string, _prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const values = { implementedAt: String(form.get("implementedAt") ?? ""), implementationUrl: String(form.get("implementationUrl") ?? ""), notes: String(form.get("notes") ?? "") };
  try {
    const user = await guard(orgSlug, projectId);
    // The date input is a calendar day. Past days are recorded at noon UTC (no time-zone shift);
    // today — or a local "today" that's already tomorrow in UTC — is recorded as now.
    const day = values.implementedAt;
    const utcToday = new Date().toISOString().slice(0, 10);
    const utcTomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const implementedAt = !/^\d{4}-\d{2}-\d{2}$/.test(day) ? day : day === utcToday || day === utcTomorrow ? new Date().toISOString() : `${day}T12:00:00.000Z`;
    await implementRecommendation(user.id, projectId, recommendationId, { ...values, implementedAt });
    refresh(orgSlug, projectId);
    return { ok: true, data: undefined };
  } catch (error) {
    return toActionError(error, values);
  }
}
