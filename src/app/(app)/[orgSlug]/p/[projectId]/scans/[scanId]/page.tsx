import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScanStatusBadge, formatUsd } from "@/components/scans/scan-status-badge";
import { getProjectPage } from "@/server/auth/session";
import { getScanDetail } from "@/server/scans/service";
import { isAppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Scan" };

interface Citation {
  url: string;
  title?: string;
  position: number;
}

const JOB_VARIANT = { SUCCEEDED: "success", FAILED: "destructive", SKIPPED: "default", PENDING: "outline", RUNNING: "outline" } as const;

export default async function ScanDetailPage({ params }: { params: Promise<{ orgSlug: string; projectId: string; scanId: string }> }) {
  const { orgSlug, projectId, scanId } = await params;
  const { user } = await getProjectPage(orgSlug, projectId);
  const detail = await getScanDetail(user.id, projectId, scanId).catch((e) => {
    if (isAppError(e)) notFound();
    throw e;
  });
  const { scan, jobs } = detail;
  const duration = scan.startedAt && scan.completedAt ? Math.round((scan.completedAt.getTime() - scan.startedAt.getTime()) / 1000) : null;

  const stats: Array<[string, string]> = [
    ["Queries", `${scan.processed} / ${scan.expectedQueryCount}`],
    ["Answers", String(scan.completedCount)],
    ["Failed", String(scan.failedCount)],
    ["Skipped", String(scan.skippedCount)],
    ["Cost", `${formatUsd(scan.actualCost)} (est. ${formatUsd(scan.estimatedCost)})`],
    ["Duration", duration === null ? "—" : `${duration}s`],
  ];

  return (
    <>
      <Link href={`/${orgSlug}/p/${projectId}`} className="mb-4 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Overview
      </Link>
      <PageHeader
        title="Scan results"
        description={`${scan.promptCount} prompts × ${scan.providerCount} engine${scan.providerCount === 1 ? "" : "s"} · started ${scan.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC`}
        actions={<ScanStatusBadge status={scan.status} />}
      />
      <Card className="mb-4 grid grid-cols-2 divide-x divide-y sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
        {stats.map(([k, v]) => (
          <div key={k} className="px-4 py-3">
            <div className="text-xs text-muted-foreground">{k}</div>
            <div className="tabular mt-1 text-sm font-medium">{v}</div>
          </div>
        ))}
      </Card>
      {scan.errorSummary ? <p className="mb-4 text-[13px] text-muted-foreground">Issues: {scan.errorSummary}</p> : null}

      <Card className="overflow-hidden">
        <ul className="divide-y">
          {jobs.map((j) => {
            const citations = ((j.response?.metadata as { citations?: Citation[] } | undefined)?.citations ?? []) as Citation[];
            return (
              <li key={j.id} className="px-4 py-3">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 basis-64 text-sm font-medium">{j.prompt.text}</span>
                    <span className="text-xs text-muted-foreground">{j.provider.displayName}</span>
                    <Badge variant={JOB_VARIANT[j.status]}>{j.status.toLowerCase()}</Badge>
                    {j.response ? (
                      <span className="tabular text-xs text-muted-foreground">
                        {(j.response.latencyMs / 1000).toFixed(1)}s · {formatUsd(Number(j.response.estimatedCost))} · {citations.length} {citations.length === 1 ? "source" : "sources"}
                      </span>
                    ) : j.errorCode ? (
                      <span className="text-xs text-muted-foreground">
                        {j.errorCode}
                        {j.attempts > 1 ? ` after ${j.attempts} attempts` : ""}
                      </span>
                    ) : null}
                  </summary>
                  <div className="mt-3 grid gap-3 text-[13px]">
                    {j.response ? (
                      <>
                        <div className="text-xs text-muted-foreground">
                          {j.response.model} · {j.country}/{j.language} · {j.response.inputTokens ?? 0} in / {j.response.outputTokens ?? 0} out tokens
                        </div>
                        <p className="whitespace-pre-wrap leading-relaxed">{j.response.normalizedText}</p>
                        {citations.length ? (
                          <ol className="grid gap-1 text-xs">
                            {citations.map((c) => (
                              <li key={c.url} className="truncate">
                                <span className="tabular text-muted-foreground">{c.position}.</span>{" "}
                                {/^https?:\/\//i.test(c.url) ? (
                                  <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">
                                    {c.title || c.url}
                                  </a>
                                ) : (
                                  <span>{c.title || c.url}</span>
                                )}
                              </li>
                            ))}
                          </ol>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-muted-foreground">{j.lastError ?? "No answer collected yet."}</p>
                    )}
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      </Card>
    </>
  );
}
