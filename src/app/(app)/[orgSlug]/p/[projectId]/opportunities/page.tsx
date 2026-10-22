import type { Metadata } from "next";
import { Flag } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Opportunities" };

export default function OpportunitiesPage() {
  return (
    <>
      <PageHeader title="Opportunities" description="Prompts and sources where you are losing visibility." />
      <EmptyState icon={Flag} title="No opportunities yet" description="Opportunities are detected automatically after scans complete." />
    </>
  );
}
