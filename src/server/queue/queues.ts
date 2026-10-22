/**
 * BullMQ queues. The web process only enqueues; workers (worker/index.ts)
 * consume. Job ids equal database ids, so re-enqueueing is idempotent and an
 * accidental loop cannot multiply paid provider calls.
 */
import { Queue, type JobsOptions } from "bullmq";
import { sharedRedis } from "./connection";
import { scanConfigFromEnv } from "@/server/scans/config";

export const QUEUE_NAMES = {
  dispatch: "scan-dispatch",
  maintenance: "scan-maintenance",
  /** One queue per provider so each has its own concurrency and rate limit. */
  query: (providerSlug: string) => `scan-query-${providerSlug}`,
} as const;

export interface DispatchJobData {
  scanId: string;
}
export interface QueryJobData {
  scanJobId: string;
}

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: sharedRedis(), defaultJobOptions: { removeOnComplete: { age: 86_400, count: 10_000 }, removeOnFail: { age: 7 * 86_400 } } });
    queues.set(name, q);
  }
  return q;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
}

export function queryJobOptions(scanJobId: string): JobsOptions {
  const cfg = scanConfigFromEnv();
  return { jobId: scanJobId, attempts: cfg.jobMaxAttempts, backoff: { type: "exponential", delay: cfg.jobBackoffMs } };
}

export async function enqueueScanDispatch(scanId: string): Promise<void> {
  await getQueue(QUEUE_NAMES.dispatch).add("dispatch", { scanId } satisfies DispatchJobData, { jobId: `dispatch-${scanId}`, attempts: 5, backoff: { type: "exponential", delay: 2_000 } });
}

export async function enqueueScanQueries(providerSlug: string, scanJobIds: string[]): Promise<void> {
  if (!scanJobIds.length) return;
  await getQueue(QUEUE_NAMES.query(providerSlug)).addBulk(scanJobIds.map((id) => ({ name: "query", data: { scanJobId: id } satisfies QueryJobData, opts: queryJobOptions(id) })));
}

/** Queue-level limits apply across every worker process. */
export async function applyProviderQueueLimits(providerSlug: string, limits: { maxConcurrency: number; requestsPerMinute: number }): Promise<void> {
  const q = getQueue(QUEUE_NAMES.query(providerSlug));
  await q.setGlobalConcurrency(Math.max(1, limits.maxConcurrency));
  await q.setGlobalRateLimit(Math.max(1, limits.requestsPerMinute), 60_000);
}
