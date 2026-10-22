import "server-only";
import { cache } from "react";
import { requireProjectPage } from "@/server/auth/session";
import { getOnboardingState } from "@/server/onboarding/service";

/** Per-request cached: authorizes (404 on denial or org mismatch) and loads onboarding state. */
export const loadOnboarding = cache(async (orgSlug: string, projectId: string) => {
  const { user } = await requireProjectPage(orgSlug, projectId, "project:update");
  const state = await getOnboardingState(user.id, projectId);
  return { user, ...state, basePath: `/${orgSlug}/onboarding/${projectId}` };
});
