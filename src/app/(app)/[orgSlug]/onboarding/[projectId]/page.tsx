import { redirect } from "next/navigation";
import { nextOnboardingPath } from "@/server/onboarding/service";
import { loadOnboarding } from "./load";

export default async function OnboardingResumePage({ params }: { params: Promise<{ orgSlug: string; projectId: string }> }) {
  const { orgSlug, projectId } = await params;
  const { project, basePath } = await loadOnboarding(orgSlug, projectId);
  const next = nextOnboardingPath(project.onboardingStep);
  redirect(next ? `${basePath}/${next}` : `/${orgSlug}/p/${projectId}`);
}
