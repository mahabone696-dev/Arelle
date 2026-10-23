import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ReportView } from "@/components/reports/report-view";
import { getProjectPage } from "@/server/auth/session";
import { previewReport } from "@/server/reports/service";
import { parseDateRange } from "@/lib/date-range";

export const metadata: Metadata = { title: "Report preview" };

export default async function ReportPreviewPage({ params, searchParams }: { params: Promise<{ orgSlug: string; projectId: string }>; searchParams: Promise<{ range?: string }> }) {
  const [{ orgSlug, projectId }, sp] = await Promise.all([params, searchParams]);
  const { user } = await getProjectPage(orgSlug, projectId);
  const report = await previewReport(user.id, projectId, parseDateRange(sp.range));
  return (
    <div className="grid gap-4">
      <Link href={`/${orgSlug}/p/${projectId}/reports`} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground print:hidden">
        <ArrowLeft className="size-3.5" /> Reports
      </Link>
      <ReportView report={report} />
    </div>
  );
}
