import { redirect } from "next/navigation";

/** New projects are created through domain onboarding. */
export default async function NewProjectPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  redirect(`/${orgSlug}/onboarding`);
}
