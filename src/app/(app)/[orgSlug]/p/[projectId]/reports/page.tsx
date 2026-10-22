import type { Metadata } from "next";
import { BookOpenText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" description="Shareable, read-only visibility reports." />
      <EmptyState icon={BookOpenText} title="No reports yet" description="Reports summarize visibility, competitors, citation gaps and completed actions." />
    </>
  );
}
