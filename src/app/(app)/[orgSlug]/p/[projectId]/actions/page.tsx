import type { Metadata } from "next";
import { ListChecks } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Actions" };

export default function ActionsPage() {
  return (
    <>
      <PageHeader title="Actions" description="Recommended work and its observed impact over time." />
      <EmptyState icon={ListChecks} title="No actions yet" description="Mark recommendations as planned or implemented to measure observed change after implementation." />
    </>
  );
}
