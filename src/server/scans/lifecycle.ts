/**
 * Scan job state transitions. Each job reaches exactly one terminal state
 * (SUCCEEDED / FAILED / SKIPPED) through a conditional update, and the scan
 * counter for that state is incremented in the same transaction — so counts
 * stay exact under retries, duplicate deliveries and concurrent workers.
 */
import { db, type DbTransaction } from "@/server/db";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { logger } from "@/lib/logger";
import type { ScanStatus } from "@/generated/prisma/enums";

const log = logger.child({ component: "scans.lifecycle" });
const OPEN = ["PENDING", "RUNNING"] as const;

type Terminal = "FAILED" | "SKIPPED";

/** Moves an open job to FAILED/SKIPPED and bumps the scan counter. Returns false if it was already terminal. */
export async function closeJob(jobId: string, status: Terminal, errorCode: string, message: string, client: DbTransaction | typeof db = db): Promise<boolean> {
  const run = async (tx: DbTransaction) => {
    const { count } = await tx.scanJob.updateMany({
      where: { id: jobId, status: { in: [...OPEN] } },
      data: { status, errorCode, lastError: message.slice(0, 1000), finishedAt: new Date() },
    });
    if (count === 0) return false;
    const job = await tx.scanJob.findUniqueOrThrow({ where: { id: jobId }, select: { scanId: true } });
    await tx.scan.update({ where: { id: job.scanId }, data: status === "FAILED" ? { failedCount: { increment: 1 } } : { skippedCount: { increment: 1 } } });
    return true;
  };
  return client === db ? db.$transaction(run) : run(client as DbTransaction);
}

/** Closes every open job of a scan (kill switch, cancellation, sweeper). */
export async function closeOpenJobs(scanId: string, status: Terminal, errorCode: string, message: string): Promise<number> {
  const open = await db.scanJob.findMany({ where: { scanId, status: { in: [...OPEN] } }, select: { id: true } });
  let closed = 0;
  for (const j of open) if (await closeJob(j.id, status, errorCode, message)) closed++;
  return closed;
}

export function finalStatus(counts: { expected: number; completed: number }, cancelled: boolean): ScanStatus {
  if (cancelled) return "CANCELLED";
  if (counts.completed === counts.expected) return "COMPLETED";
  if (counts.completed > 0) return "PARTIAL";
  return "FAILED";
}

/**
 * Finalizes a scan once every job is terminal. Safe to call repeatedly and
 * concurrently: only the call that flips status from QUEUED/RUNNING wins.
 */
export async function finalizeScanIfDone(scanId: string, options: { cancelled?: boolean } = {}): Promise<ScanStatus | null> {
  const scan = await db.scan.findUnique({
    where: { id: scanId },
    select: { status: true, expectedQueryCount: true, completedCount: true, failedCount: true, skippedCount: true, projectId: true, project: { select: { organizationId: true } } },
  });
  if (!scan || (scan.status !== "RUNNING" && scan.status !== "QUEUED")) return null;
  const processed = scan.completedCount + scan.failedCount + scan.skippedCount;
  if (processed < scan.expectedQueryCount) return null;

  const status = finalStatus({ expected: scan.expectedQueryCount, completed: scan.completedCount }, options.cancelled === true);
  const errorSummary =
    status === "COMPLETED" ? null : await summarizeErrors(scanId);
  const { count } = await db.scan.updateMany({ where: { id: scanId, status: { in: ["RUNNING", "QUEUED"] } }, data: { status, completedAt: new Date(), errorSummary } });
  if (count === 0) return null;

  log.info("scan.finalized", { scanId, status, completed: scan.completedCount, failed: scan.failedCount, skipped: scan.skippedCount });
  await writeAuditLog({ organizationId: scan.project.organizationId, action: `scan.${status.toLowerCase()}`, entityType: "Scan", entityId: scanId, metadata: { completed: scan.completedCount, failed: scan.failedCount, skipped: scan.skippedCount } });
  // Phase 4 hooks in here: response analysis → visibility snapshots → opportunities.
  return status;
}

async function summarizeErrors(scanId: string): Promise<string | null> {
  const groups = await db.scanJob.groupBy({ by: ["errorCode"], where: { scanId, status: { in: ["FAILED", "SKIPPED"] } }, _count: { _all: true } });
  if (!groups.length) return null;
  return groups.map((g) => `${g.errorCode ?? "UNKNOWN"}: ${g._count._all}`).join(", ");
}
