import type { Metadata } from "next";
import { MessageSquareText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Prompts" };

export default function PromptsPage() {
  return (
    <>
      <PageHeader title="Prompts" description="Track the questions your customers ask AI engines." />
      <EmptyState icon={MessageSquareText} title="No prompts yet" description="Prompts are generated from your website during onboarding. You can approve, edit and add your own." />
    </>
  );
}
