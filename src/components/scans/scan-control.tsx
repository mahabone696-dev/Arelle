"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScanStatusBadge, formatUsd } from "./scan-status-badge";
import type { ActionResult } from "@/lib/errors";

export interface ScanPreviewData {
  promptCount: number;
  providerCount: number;
  expectedQueryCount: number;
  estimatedCost: number;
  providers: Array<{ displayName: string; model: string }>;
  unavailable: Array<{ displayName: string; label: string }>;
  blockedReason?: string;
}

interface Progress {
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED";
  expectedQueryCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
  processed: number;
  actualCost: number;
  errorSummary: string | null;
}

const ACTIVE = new Set(["QUEUED", "RUNNING"]);

function useScanProgress(projectId: string, scanId: string | null) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const router = useRouter();
  useEffect(() => {
    if (!scanId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/scans/${scanId}`, { cache: "no-store" });
        if (res.ok) {
          const p = (await res.json()) as Progress;
          if (stop) return;
          setProgress(p);
          if (!ACTIVE.has(p.status)) {
            router.refresh();
            return;
          }
        }
      } catch {
        /* transient network error: keep polling */
      }
      if (!stop) timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [projectId, scanId, router]);
  return progress;
}

export function ScanControl({
  orgSlug,
  projectId,
  preview,
  activeScanId,
  canRun,
  run,
}: {
  orgSlug: string;
  projectId: string;
  preview: ScanPreviewData;
  activeScanId: string | null;
  canRun: boolean;
  run: () => Promise<ActionResult<{ scanId: string }>>;
}) {
  const [scanId, setScanId] = useState<string | null>(activeScanId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const progress = useScanProgress(projectId, scanId);
  const running = scanId && (!progress || ACTIVE.has(progress.status));

  if (scanId && progress && !running) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-[13px]">
        <ScanStatusBadge status={progress.status} />
        <span className="tabular">
          {progress.completedCount} of {progress.expectedQueryCount} answers collected
          {progress.failedCount ? ` · ${progress.failedCount} failed` : ""}
          {progress.skippedCount ? ` · ${progress.skippedCount} skipped` : ""} · {formatUsd(progress.actualCost)}
        </span>
        <Link href={`/${orgSlug}/p/${projectId}/scans/${scanId}`} className="font-medium hover:underline">
          View results
        </Link>
        <Button size="sm" variant="ghost" onClick={() => setScanId(null)}>
          Done
        </Button>
      </div>
    );
  }

  if (running) {
    const processed = progress?.processed ?? 0;
    const expected = progress?.expectedQueryCount ?? preview.expectedQueryCount;
    const pct = expected ? Math.round((processed / expected) * 100) : 0;
    return (
      <div className="grid w-full gap-2 sm:w-80" aria-live="polite">
        <div className="flex justify-between text-[13px]">
          <span className="font-medium">{progress?.status === "QUEUED" || !progress ? "Starting scan…" : "Scanning"}</span>
          <span className="tabular text-muted-foreground">
            {processed} / {expected} responses
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-valuenow={processed} aria-valuemin={0} aria-valuemax={expected}>
          <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        {progress?.failedCount ? <span className="text-xs text-muted-foreground">{progress.failedCount} failed so far — the scan continues.</span> : null}
      </div>
    );
  }

  const blocked = preview.blockedReason ?? (!canRun ? "You don't have permission to run scans." : undefined);
  return (
    <div className="grid gap-2">
      {confirming ? (
        <div className="grid gap-3 rounded-md border bg-card p-3 text-[13px] sm:w-96">
          <div>
            <span className="tabular font-medium">{preview.promptCount}</span> prompts × <span className="tabular font-medium">{preview.providerCount}</span>{" "}
            {preview.providerCount === 1 ? "engine" : "engines"} = <span className="tabular font-medium">{preview.expectedQueryCount}</span> queries
            <div className="mt-1 text-muted-foreground">
              {preview.providers.map((p) => `${p.displayName} (${p.model})`).join(", ")} · estimated {formatUsd(preview.estimatedCost)}
            </div>
            {preview.unavailable.length ? <div className="mt-1 text-xs text-muted-foreground">Not included: {preview.unavailable.map((u) => `${u.displayName} — ${u.label}`).join("; ")}</div> : null}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await run();
                  if (res.ok) {
                    setScanId(res.data.scanId);
                    setConfirming(false);
                    setError(null);
                  } else setError(res.error);
                })
              }
            >
              {pending ? "Starting…" : `Run ${preview.expectedQueryCount} queries`}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" disabled={!!blocked} title={blocked} onClick={() => setConfirming(true)} className="justify-self-start">
          <Play /> Run scan
        </Button>
      )}
      {blocked ? <span className="text-xs text-muted-foreground">{blocked}</span> : null}
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
