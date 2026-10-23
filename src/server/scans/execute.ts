/**
 * Worker-side scan execution. Framework-agnostic; the BullMQ wiring in
 * worker/ only translates the returned outcome into "done" or "retry".
 *
 * Guarantees:
 * - Every guard (kill switch, scan state, runtime quota) is re-checked
 *   immediately before each paid provider call, including retries.
 * - A provider failure only affects its own job; the scan continues.
 * - AIResponse is written once (unique scanJobId); duplicates are no-ops.
 */
import { db } from "@/server/db";
import { getScanKillSwitch } from "@/server/system/settings";
import { getReadyProvider, type ReadyProvider } from "@/server/providers/registry";
import { isProviderError, ProviderError } from "@/server/providers/errors";
import { effectiveTier, planLimits } from "@/server/billing/plans";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/monitoring";
import { scanConfigFromEnv, utcDayKey, type ScanConfig } from "./config";
import { closeJob, closeOpenJobs, finalizeScanIfDone } from "./lifecycle";
import type { QuotaGuard } from "./quota";

const log = logger.child({ component: "scans.execute" });

export interface ExecuteDeps {
  getProvider: (providerId: string) => Promise<ReadyProvider | null>;
  quota: QuotaGuard;
  config: ScanConfig;
  isKillSwitchOn: () => Promise<boolean>;
}

export function defaultExecuteDeps(quota: QuotaGuard): ExecuteDeps {
  return { getProvider: (id) => getReadyProvider(id), quota, config: scanConfigFromEnv(), isKillSwitchOn: async () => (await getScanKillSwitch()).enabled };
}

export type ExecuteOutcome =
  | { kind: "SUCCEEDED"; responseId: string }
  | { kind: "FAILED"; code: string }
  | { kind: "SKIPPED"; code: string }
  | { kind: "RETRY"; code: string; retryAfterMs?: number }
  | { kind: "NOOP" };

/**
 * @param attempt 1-based attempt number for this delivery
 * @param maxAttempts attempts allowed by the queue for this job
 */
export async function executeScanJob(scanJobId: string, attempt: number, maxAttempts: number, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const job = await db.scanJob.findUnique({
    where: { id: scanJobId },
    include: {
      scan: { select: { id: true, status: true, projectId: true, project: { select: { organizationId: true, organization: { select: { subscription: { select: { planTier: true, status: true } } } } } } } },
      prompt: { select: { text: true } },
      response: { select: { id: true } },
    },
  });
  if (!job) return { kind: "NOOP" };
  if (job.response) {
    // Answer already stored (e.g. crash after persisting) — make sure state reflects it.
    await markSucceededIfOpen(job.id, job.scanId);
    return { kind: "NOOP" };
  }
  if (job.status !== "PENDING" && job.status !== "RUNNING") return { kind: "NOOP" };

  const scanId = job.scanId;
  const skip = async (code: string, message: string): Promise<ExecuteOutcome> => {
    await closeJob(job.id, "SKIPPED", code, message);
    await finalizeScanIfDone(scanId, { cancelled: code === "SCAN_CANCELLED" });
    return { kind: "SKIPPED", code };
  };

  if (job.scan.status === "CANCELLED" || job.scan.status === "FAILED" || job.scan.status === "COMPLETED" || job.scan.status === "PARTIAL") {
    return skip("SCAN_CLOSED", `Scan is ${job.scan.status}`);
  }
  if (await deps.isKillSwitchOn()) {
    // Halt the whole scan at once rather than job by job.
    await closeOpenJobs(scanId, "SKIPPED", "KILL_SWITCH", "Halted by the global scan kill switch");
    await finalizeScanIfDone(scanId, { cancelled: true });
    return { kind: "SKIPPED", code: "KILL_SWITCH" };
  }

  const provider = await deps.getProvider(job.providerId);
  if (!provider) return fail(job.id, scanId, "PROVIDER_UNAVAILABLE", "Provider is no longer enabled or configured");

  const organizationId = job.scan.project.organizationId;
  const orgCap = Math.min(planLimits(effectiveTier(job.scan.project.organization.subscription)).queriesPerDay, deps.config.orgDailyQueryCap);
  const exceeded = await deps.quota.reserve({ organizationId, providerSlug: provider.slug, caps: { global: deps.config.globalDailyQueryCap, org: orgCap, provider: provider.dailyQueryCap } });
  if (exceeded) {
    log.warn("scan_job.quota_exceeded", { scanJobId, scope: exceeded });
    return skip(`DAILY_CAP_${exceeded}`, `Daily ${exceeded.toLowerCase()} query cap reached`);
  }

  await db.scanJob.update({ where: { id: job.id }, data: { status: "RUNNING", attempts: { increment: 1 }, startedAt: job.startedAt ?? new Date() } });

  try {
    const result = await provider.adapter.query({ prompt: job.prompt.text, country: job.country, language: job.language, projectId: job.scan.projectId, promptId: job.promptId });
    // The answer is paid for: retry persistence locally rather than re-querying the provider.
    const responseId = await withPersistRetry(() => persistResponse(job, provider, result, organizationId), scanJobId);
    await finalizeScanIfDone(scanId);
    log.info("scan_job.succeeded", { scanJobId, provider: provider.slug, latencyMs: result.latencyMs, costUsd: result.estimatedCost, citations: result.citations.length });
    return { kind: "SUCCEEDED", responseId };
  } catch (error) {
    if (error instanceof PersistError) return fail(job.id, scanId, "PERSIST_FAILED", error.message);
    const pe = isProviderError(error) ? error : new ProviderError(provider.slug, "UNKNOWN", "Unexpected error while querying the provider");
    if (!isProviderError(error)) captureException(error, { component: "scans.execute", scanJobId });
    log.warn("scan_job.provider_error", { scanJobId, provider: provider.slug, code: pe.code, retryable: pe.retryable, attempt, maxAttempts, status: pe.details.status });
    if (pe.retryable && attempt < maxAttempts) {
      await db.scanJob.update({ where: { id: job.id }, data: { status: "PENDING", errorCode: pe.code, lastError: pe.message } });
      return { kind: "RETRY", code: pe.code, retryAfterMs: pe.details.retryAfterMs };
    }
    return fail(job.id, scanId, pe.code, pe.message);
  }
}

const PERSIST_ATTEMPTS = 4;

export async function withPersistRetry<T>(fn: () => Promise<T>, scanJobId: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= PERSIST_ATTEMPTS) {
        captureException(error, { component: "scans.persist", scanJobId, attempts: attempt });
        throw new PersistError();
      }
      log.warn("scan_job.persist_retry", { scanJobId, attempt });
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
}

/** Storing a paid answer failed repeatedly; surfaces as a non-retryable job failure (no re-query). */
export class PersistError extends Error {
  constructor() {
    super("Failed to store the provider answer");
    this.name = "PersistError";
  }
}

async function fail(jobId: string, scanId: string, code: string, message: string): Promise<ExecuteOutcome> {
  await closeJob(jobId, "FAILED", code, message);
  await finalizeScanIfDone(scanId);
  return { kind: "FAILED", code };
}

async function markSucceededIfOpen(jobId: string, scanId: string) {
  await db.$transaction(async (tx) => {
    const { count } = await tx.scanJob.updateMany({ where: { id: jobId, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "SUCCEEDED", finishedAt: new Date(), errorCode: null, lastError: null } });
    if (count) await tx.scan.update({ where: { id: scanId }, data: { completedCount: { increment: 1 } } });
  });
  await finalizeScanIfDone(scanId);
}

type LoadedJob = { id: string; scanId: string; promptId: string; providerId: string; country: string; language: string; prompt: { text: string } };

async function persistResponse(job: LoadedJob, provider: ReadyProvider, result: Awaited<ReturnType<ReadyProvider["adapter"]["query"]>>, organizationId: string): Promise<string> {
  try {
    return await db.$transaction(async (tx) => {
      const response = await tx.aIResponse.create({
        data: {
          scanId: job.scanId,
          scanJobId: job.id,
          promptId: job.promptId,
          providerId: provider.providerId,
          modelId: provider.modelRowId,
          model: result.model,
          country: job.country,
          language: job.language,
          promptText: job.prompt.text,
          rawText: result.rawText,
          normalizedText: result.normalizedText,
          latencyMs: result.latencyMs,
          inputTokens: result.tokenUsage.input,
          outputTokens: result.tokenUsage.output,
          estimatedCost: result.estimatedCost,
          // Provider-reported citations are kept with the raw response; Phase 4 normalizes them into Citation rows.
          metadata: JSON.parse(JSON.stringify({ ...result.metadata, citations: result.citations })) as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      const { count } = await tx.scanJob.updateMany({ where: { id: job.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "SUCCEEDED", finishedAt: new Date(), errorCode: null, lastError: null } });
      if (count) await tx.scan.update({ where: { id: job.scanId }, data: { completedCount: { increment: 1 }, actualCost: { increment: result.estimatedCost } } });
      await tx.usageRecord.create({
        data: { organizationId, metric: "PROVIDER_QUERY", quantity: 1, costUsd: result.estimatedCost, periodKey: utcDayKey(), providerSlug: provider.slug, referenceId: job.id },
      });
      return response.id;
    });
  } catch (error) {
    // A concurrent delivery already stored this job's answer: keep the first, never overwrite.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await db.aIResponse.findUniqueOrThrow({ where: { scanJobId: job.id }, select: { id: true } });
      await markSucceededIfOpen(job.id, job.scanId);
      return existing.id;
    }
    throw error;
  }
}
