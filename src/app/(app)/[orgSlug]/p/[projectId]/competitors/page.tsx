import type { Metadata } from "next";
import { Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Competitors" };

export default function CompetitorsPage() {
  return (
    <>
      <PageHeader title="Competitors" description="Compare your AI visibility against competing brands." />
      <EmptyState icon={Users} title="No competitors yet" description="Competitors are suggested during onboarding and can be edited at any time." />
    </>
  );
}
