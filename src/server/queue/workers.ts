/**
 * BullMQ worker wiring, shared by the standalone worker process and tests.
 * All business logic lives in src/server/scans; this file only maps queue
 * jobs to it and translates outcomes into BullMQ semantics.
 */
import { Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { db } from "@/server/db";
import { dispatchScan, sweepScans, type DispatchDeps, defaultDispatchDeps } from "@/server/scans/dispatch";
import { defaultExecuteDeps, executeScanJob, type ExecuteDeps } from "@/server/scans/execute";
import { closeJob, finalizeScanIfDone, setScanFinalizedHook } from "@/server/scans/lifecycle";
import { analyzeScan, defaultAnalysisDeps, type AnalysisDeps } from "@/server/analysis/service";
import { afterScanAnalyzed } from "@/server/opportunities/service";
import { redisQuotaGuard } from "@/server/scans/quota";
import { scanConfigFromEnv } from "@/server/scans/config";
import { IMPLEMENTED_PROVIDERS } from "@/server/providers/registry";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/monitoring";
import { applyProviderQueueLimits, enqueueScanAnalysis, getQueue, QUEUE_NAMES, type AnalyzeJobData, type DispatchJobData, type QueryJobData } from "./queues";
import { createRedis } from "./connection";

const log = logger.child({ component: "worker" });

export interface WorkerOptions {
  /** Defaults to every implemented provider. */
  providers?: string[];
  executeDeps?: ExecuteDeps;
  dispatchDeps?: DispatchDeps;
  analysisDeps?: AnalysisDeps;
  /** Sweep interval; 0 disables the scheduler (tests). */
  sweepEveryMs?: number;
}

export interface RunningWorkers {
  close(): Promise<void>;
}

export async function startScanWorkers(options: WorkerOptions = {}): Promise<RunningWorkers> {
  const cfg = scanConfigFromEnv();
  const connections: Redis[] = [];
  const conn = () => {
    const c = createRedis();
    connections.push(c);
    return c;
  };
  const quotaRedis = conn();
  const executeDeps = options.executeDeps ?? defaultExecuteDeps(redisQuotaGuard(quotaRedis));
  const dispatchDeps = options.dispatchDeps ?? defaultDispatchDeps();
  const workers: Worker[] = [];

  const dispatchWorker = new Worker<DispatchJobData>(QUEUE_NAMES.dispatch, async (job) => dispatchScan(job.data.scanId, dispatchDeps), { connection: conn(), concurrency: 2 });
  workers.push(dispatchWorker);

  const slugs = options.providers ?? IMPLEMENTED_PROVIDERS;
  const dbRows = await db.aIProvider.findMany({ where: { slug: { in: slugs } }, select: { slug: true, maxConcurrency: true, requestsPerMinute: true } });
  // Start a consumer for every implemented provider, even if its row doesn't exist yet (e.g. worker
  // booted before db:seed); conservative defaults apply until the next restart picks up DB limits.
  const providerRows = slugs.map((slug) => dbRows.find((r) => r.slug === slug) ?? { slug, maxConcurrency: 2, requestsPerMinute: 30 });
  for (const row of providerRows) {
    // Global (cross-process) limits live on the queue; the local concurrency just bounds this process.
    await applyProviderQueueLimits(row.slug, row);
    const worker: Worker<QueryJobData> = new Worker<QueryJobData>(
      QUEUE_NAMES.query(row.slug),
      async (job: Job<QueryJobData>) => {
        const attempt = job.attemptsMade + 1;
        const outcome = await executeScanJob(job.data.scanJobId, attempt, job.opts.attempts ?? 1, executeDeps);
        if (outcome.kind === "RETRY") {
          // Provider asked us to slow down: pause this queue for everyone, then retry with backoff.
          if (outcome.retryAfterMs) await worker.rateLimit(Math.min(outcome.retryAfterMs, 60_000));
          throw new Error(`Retryable provider error: ${outcome.code}`);
        }
        return outcome;
      },
      { connection: conn(), concurrency: Math.max(1, row.maxConcurrency), lockDuration: 120_000 },
    );
    worker.on("failed", async (job, error) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      log.warn("worker.job_failed", { queue: worker.name, scanJobId: job.data.scanJobId, attempt: job.attemptsMade, final, error: error.message });
      if (!final) return;
      // Out of attempts without a recorded outcome (e.g. DB outage): close the job so the scan can finish.
      try {
        if (await closeJob(job.data.scanJobId, "FAILED", "WORKER_ERROR", error.message)) {
          const scanJob = await db.scanJob.findUnique({ where: { id: job.data.scanJobId }, select: { scanId: true } });
          if (scanJob) await finalizeScanIfDone(scanJob.scanId);
        }
      } catch (e) {
        captureException(e, { component: "worker.failed_handler", scanJobId: job.data.scanJobId });
      }
    });
    workers.push(worker);
    log.info("worker.provider_started", { provider: row.slug, concurrency: row.maxConcurrency, requestsPerMinute: row.requestsPerMinute });
  }

  const analysisDeps = options.analysisDeps ?? defaultAnalysisDeps();
  workers.push(
    new Worker<AnalyzeJobData>(
      QUEUE_NAMES.analyze,
      async (job) => {
        const analysis = await analyzeScan(job.data.scanId, analysisDeps);
        // Opportunities + action measurements are idempotent, so a retried job simply re-runs them.
        const followUp = await afterScanAnalyzed(job.data.scanId);
        return { analysis, followUp };
      },
      { connection: conn(), concurrency: 2 },
    ),
  );
  setScanFinalizedHook(async (scanId, status) => {
    if (status !== "FAILED") {
      await db.scan.updateMany({ where: { id: scanId, analysisStatus: null, completedCount: { gt: 0 } }, data: { analysisStatus: "PENDING" } });
      await enqueueScanAnalysis(scanId);
    }
  });

  const maintenance = new Worker(QUEUE_NAMES.maintenance, async () => sweepScans({ staleScanMs: cfg.staleScanMs, stuckQueuedMs: cfg.stuckQueuedMs }, dispatchDeps), { connection: conn(), concurrency: 1 });
  workers.push(maintenance);
  const sweepEvery = options.sweepEveryMs ?? 5 * 60_000;
  if (sweepEvery > 0) await getQueue(QUEUE_NAMES.maintenance).upsertJobScheduler("sweep-scans", { every: sweepEvery }, { name: "sweep" });

  for (const w of workers) {
    w.on("error", (error) => {
      log.error("worker.error", { queue: w.name, error });
      captureException(error, { component: "worker", queue: w.name });
    });
  }

  return {
    async close() {
      setScanFinalizedHook(null);
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all(connections.map((c) => c.quit().catch(() => {})));
    },
  };
}
