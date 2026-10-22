/**
 * Dispatch: QUEUED scan → RUNNING, enqueue one query job per open ScanJob on
 * its provider's queue. Idempotent: queue job ids are ScanJob ids, so a
 * repeated dispatch (retry, sweeper) never duplicates paid work.
 */
import { db } from "@/server/db";
import { getScanKillSwitch } from "@/server/system/settings";
import { enqueueScanQueries } from "@/server/queue/queues";
import { logger } from "@/lib/logger";
import { closeOpenJobs, finalizeScanIfDone } from "./lifecycle";

const log = logger.child({ component: "scans.dispatch" });

export interface DispatchDeps {
  enqueueQueries: (providerSlug: string, scanJobIds: string[]) => Promise<void>;
  isKillSwitchOn: () => Promise<boolean>;
}

export const defaultDispatchDeps = (): DispatchDeps => ({ enqueueQueries: enqueueScanQueries, isKillSwitchOn: async () => (await getScanKillSwitch()).enabled });

export async function dispatchScan(scanId: string, deps: DispatchDeps = defaultDispatchDeps()): Promise<"DISPATCHED" | "CANCELLED" | "NOOP"> {
  const scan = await db.scan.findUnique({ where: { id: scanId }, select: { status: true } });
  if (!scan || (scan.status !== "QUEUED" && scan.status !== "RUNNING")) return "NOOP";

  if (await deps.isKillSwitchOn()) {
    await closeOpenJobs(scanId, "SKIPPED", "KILL_SWITCH", "Halted by the global scan kill switch");
    await finalizeScanIfDone(scanId, { cancelled: true });
    log.warn("scan.dispatch_blocked_by_kill_switch", { scanId });
    return "CANCELLED";
  }

  await db.scan.updateMany({ where: { id: scanId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date() } });
  const jobs = await db.scanJob.findMany({ where: { scanId, status: { in: ["PENDING", "RUNNING"] } }, select: { id: true, provider: { select: { slug: true } } } });
  const bySlug = new Map<string, string[]>();
  for (const j of jobs) bySlug.set(j.provider.slug, [...(bySlug.get(j.provider.slug) ?? []), j.id]);
  for (const [slug, ids] of bySlug) await deps.enqueueQueries(slug, ids);
  log.info("scan.dispatched", { scanId, jobs: jobs.length, providers: [...bySlug.keys()] });
  // A scan whose jobs were all closed before dispatch (e.g. caps) finalizes here.
  await finalizeScanIfDone(scanId);
  return "DISPATCHED";
}

/**
 * Maintenance sweep (runs every few minutes in the worker):
 * - QUEUED scans whose dispatch was lost → dispatch again (idempotent).
 * - RUNNING scans past the stale threshold → fail their open jobs (STALLED) and finalize.
 * - RUNNING scans whose jobs are all terminal but weren't finalized → finalize.
 */
export async function sweepScans(options: { staleScanMs: number; stuckQueuedMs: number }, deps: DispatchDeps = defaultDispatchDeps()) {
  const now = Date.now();
  const stuck = await db.scan.findMany({ where: { status: "QUEUED", createdAt: { lt: new Date(now - options.stuckQueuedMs) } }, select: { id: true } });
  for (const s of stuck) await dispatchScan(s.id, deps);

  const stale = await db.scan.findMany({ where: { status: "RUNNING", startedAt: { lt: new Date(now - options.staleScanMs) } }, select: { id: true } });
  for (const s of stale) {
    const closed = await closeOpenJobs(s.id, "FAILED", "STALLED", "Job did not complete within the scan time limit");
    log.warn("scan.stale_jobs_failed", { scanId: s.id, closed });
    await finalizeScanIfDone(s.id);
  }

  const running = await db.scan.findMany({ where: { status: "RUNNING" }, select: { id: true } });
  for (const s of running) await finalizeScanIfDone(s.id);
  return { redispatched: stuck.length, staleFailed: stale.length };
}
