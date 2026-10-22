import type { Metadata } from "next";
import { Link2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Citations" };

export default function CitationsPage() {
  return (
    <>
      <PageHeader title="Citations" description="The sources AI engines cite when answering your prompts." />
      <EmptyState icon={Link2} title="No citations collected" description="Citations are extracted from AI answers after each scan." />
    </>
  );
}
