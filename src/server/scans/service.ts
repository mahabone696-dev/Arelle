/**
 * Scan admission: everything that must hold BEFORE any paid query is queued.
 *
 *   kill switch → providers ready → prompts → plan (prompts × providers)
 *   → limits (plan tier, per-scan, org/global/provider daily caps,
 *     one active scan per project) → Scan + ScanJobs → enqueue dispatch.
 *
 * Limit checks and row creation run in one transaction holding a global
 * advisory lock, so concurrent "Run scan" clicks can't both slip under a cap.
 */
import { db } from "@/server/db";
import { requireProjectAccess } from "@/server/auth/authorization";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { getScanKillSwitch } from "@/server/system/settings";
import { getProviderAvailability, type ProviderAvailability } from "@/server/providers/registry";
import { enqueueScanDispatch } from "@/server/queue/queues";
import { planLimits } from "@/server/billing/plans";
import type { ScanType } from "@/generated/prisma/enums";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/monitoring";
import { rateLimit } from "@/lib/rate-limit";
import { scanConfigFromEnv, utcDayKey, utcDayStart, type ScanConfig } from "./config";
import { computeScanPlan, type ScanPlan } from "./plan";

const SCAN_ADMISSION_LOCK = 7_301_001;
const log = logger.child({ component: "scans" });

export interface ScanServiceDeps {
  availability: () => Promise<ProviderAvailability>;
  enqueueDispatch: (scanId: string) => Promise<void>;
  config: ScanConfig;
}

export function defaultScanDeps(): ScanServiceDeps {
  return { availability: () => getProviderAvailability(), enqueueDispatch: enqueueScanDispatch, config: scanConfigFromEnv() };
}

export interface ScanPreview extends ScanPlan {
  providers: Array<{ slug: string; displayName: string; model: string }>;
  unavailable: ProviderAvailability["unavailable"];
  killSwitch: boolean;
  blockedReason?: string;
}

async function activePrompts(projectId: string) {
  return db.prompt.findMany({
    where: { projectId, isActive: true },
    select: { id: true, text: true, country: true, language: true },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
}

/** What a scan would do right now (for the confirmation UI). Never enqueues anything. */
export async function previewScan(userId: string, projectId: string, deps: ScanServiceDeps = defaultScanDeps()): Promise<ScanPreview> {
  await requireProjectAccess(userId, projectId, "project:read");
  const [kill, availability, prompts] = await Promise.all([getScanKillSwitch(), deps.availability(), activePrompts(projectId)]);
  const plan = await computeScanPlan(projectId, prompts, availability.ready);
  let blockedReason: string | undefined;
  if (kill.enabled) blockedReason = "Scanning is temporarily paused.";
  else if (!availability.ready.length) blockedReason = "No AI engines are available.";
  else if (!prompts.length) blockedReason = "Approve at least one prompt first.";
  return {
    ...plan,
    providers: availability.ready.map((p) => ({ slug: p.slug, displayName: p.displayName, model: p.modelId })),
    unavailable: availability.unavailable,
    killSwitch: kill.enabled,
    blockedReason,
  };
}

export async function createScan(userId: string, projectId: string, options: { scanType?: ScanType } = {}, deps: ScanServiceDeps = defaultScanDeps()) {
  const access = await requireProjectAccess(userId, projectId, "scan:run");
  const scanType = options.scanType ?? "MANUAL";
  const cfg = deps.config;

  const userLimit = await rateLimit(`scan:create:${userId}`, 20, 60 * 60 * 1000);
  if (!userLimit.allowed) throw new AppError("LIMIT_EXCEEDED", "Too many scans started recently. Try again later.");

  const kill = await getScanKillSwitch();
  if (kill.enabled) throw new AppError("UNAVAILABLE", "Scanning is temporarily paused by the platform. Please try again later.", { reason: "KILL_SWITCH" });

  const availability = await deps.availability();
  if (!availability.ready.length) {
    throw new AppError("UNAVAILABLE", "No AI engines are available to scan right now.", { unavailable: availability.unavailable });
  }

  const prompts = await activePrompts(projectId);
  if (!prompts.length) throw new AppError("VALIDATION", "Approve at least one prompt before running a scan.");

  const plan = await computeScanPlan(projectId, prompts, availability.ready);
  if (plan.expectedQueryCount > cfg.maxQueriesPerScan) {
    throw new AppError("LIMIT_EXCEEDED", `This scan would run ${plan.expectedQueryCount} queries; the maximum per scan is ${cfg.maxQueriesPerScan}.`);
  }

  const subscription = await db.subscription.findUnique({ where: { organizationId: access.organizationId }, select: { planTier: true } });
  const limits = planLimits(subscription?.planTier);
  if (plan.promptCount > limits.prompts) {
    throw new AppError("LIMIT_EXCEEDED", `Your plan scans up to ${limits.prompts} prompts per project; ${plan.promptCount} are active. Deactivate some prompts or upgrade.`);
  }
  const orgCap = Math.min(limits.queriesPerDay, cfg.orgDailyQueryCap);
  const since = utcDayStart();

  const scan = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SCAN_ADMISSION_LOCK}::bigint)::text AS locked`;

    const active = await tx.scan.findFirst({ where: { projectId, status: { in: ["QUEUED", "RUNNING"] } }, select: { id: true } });
    if (active) throw new AppError("CONFLICT", "A scan is already running for this project.", { scanId: active.id });

    if (scanType === "MANUAL") {
      const manualToday = await tx.scan.count({ where: { project: { organizationId: access.organizationId }, scanType: "MANUAL", createdAt: { gte: since }, isDemo: false } });
      if (manualToday >= limits.manualScansPerDay) {
        throw new AppError("LIMIT_EXCEEDED", `Your plan allows ${limits.manualScansPerDay} manual scan${limits.manualScansPerDay === 1 ? "" : "s"} per day.`);
      }
    }

    // Planned queries already admitted today (skipped jobs never cost anything).
    const plannedToday = (where: object) => tx.scanJob.count({ where: { createdAt: { gte: since }, status: { not: "SKIPPED" }, ...where } });
    const [orgUsed, globalUsed] = await Promise.all([plannedToday({ scan: { project: { organizationId: access.organizationId } } }), plannedToday({})]);
    if (orgUsed + plan.expectedQueryCount > orgCap) {
      throw new AppError("LIMIT_EXCEEDED", `Daily query limit reached: ${orgUsed} of ${orgCap} used today, this scan needs ${plan.expectedQueryCount}.`);
    }
    if (globalUsed + plan.expectedQueryCount > cfg.globalDailyQueryCap) {
      log.warn("scans.global_cap_reached", { globalUsed, cap: cfg.globalDailyQueryCap });
      throw new AppError("UNAVAILABLE", "Scanning capacity for today has been reached. Please try again tomorrow.");
    }
    for (const p of availability.ready) {
      const used = await plannedToday({ providerId: p.providerId });
      if (used + prompts.length > p.dailyQueryCap) throw new AppError("UNAVAILABLE", `${p.displayName} has reached its daily query limit. Please try again tomorrow.`);
    }

    const created = await tx.scan.create({
      data: {
        projectId,
        scanType,
        status: "QUEUED",
        promptCount: plan.promptCount,
        providerCount: plan.providerCount,
        expectedQueryCount: plan.expectedQueryCount,
        estimatedCost: plan.estimatedCost,
        triggeredById: userId,
        plan: {
          providers: availability.ready.map((p) => ({ providerId: p.providerId, slug: p.slug, model: p.modelId })),
          unavailable: availability.unavailable,
          perProvider: plan.perProvider,
          limits: { planTier: subscription?.planTier ?? "FREE", orgDailyQueryCap: orgCap, orgUsedBefore: orgUsed },
        },
      },
    });
    await tx.scanJob.createMany({
      data: availability.ready.flatMap((p) =>
        prompts.map((prompt) => ({ scanId: created.id, promptId: prompt.id, providerId: p.providerId, modelId: p.modelRowId, country: prompt.country, language: prompt.language })),
      ),
    });
    await tx.usageRecord.create({ data: { organizationId: access.organizationId, metric: "SCAN", quantity: 1, periodKey: utcDayKey(), referenceId: created.id } });
    return created;
  }, { maxWait: 10_000, timeout: 20_000 });

  try {
    await deps.enqueueDispatch(scan.id);
  } catch (error) {
    captureException(error, { component: "scans.enqueue", scanId: scan.id });
    await db.$transaction([
      db.scanJob.updateMany({ where: { scanId: scan.id }, data: { status: "SKIPPED", errorCode: "QUEUE_UNAVAILABLE" } }),
      db.scan.update({ where: { id: scan.id }, data: { status: "FAILED", skippedCount: plan.expectedQueryCount, errorSummary: "The scan queue is unavailable.", completedAt: new Date() } }),
    ]);
    throw new AppError("UNAVAILABLE", "The scan could not be started because the job queue is unavailable. Please try again.");
  }

  await writeAuditLog({
    organizationId: access.organizationId,
    actorId: userId,
    action: "scan.created",
    entityType: "Scan",
    entityId: scan.id,
    metadata: { expectedQueryCount: plan.expectedQueryCount, promptCount: plan.promptCount, providerCount: plan.providerCount, estimatedCost: plan.estimatedCost },
  });
  log.info("scan.created", { scanId: scan.id, projectId, expected: plan.expectedQueryCount, estimatedCost: plan.estimatedCost });
  return scan;
}

export async function getScanProgress(userId: string, projectId: string, scanId: string) {
  await requireProjectAccess(userId, projectId, "project:read");
  const scan = await db.scan.findFirst({
    where: { id: scanId, projectId },
    select: {
      id: true,
      status: true,
      scanType: true,
      promptCount: true,
      providerCount: true,
      expectedQueryCount: true,
      completedCount: true,
      failedCount: true,
      skippedCount: true,
      estimatedCost: true,
      actualCost: true,
      errorSummary: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });
  if (!scan) throw new AppError("NOT_FOUND", "Scan not found.");
  return { ...scan, estimatedCost: Number(scan.estimatedCost), actualCost: Number(scan.actualCost), processed: scan.completedCount + scan.failedCount + scan.skippedCount };
}

export async function getScanDetail(userId: string, projectId: string, scanId: string) {
  const progress = await getScanProgress(userId, projectId, scanId);
  const jobs = await db.scanJob.findMany({
    where: { scanId },
    select: {
      id: true,
      status: true,
      attempts: true,
      errorCode: true,
      lastError: true,
      country: true,
      language: true,
      finishedAt: true,
      prompt: { select: { text: true } },
      provider: { select: { slug: true, displayName: true } },
      response: { select: { id: true, model: true, latencyMs: true, inputTokens: true, outputTokens: true, estimatedCost: true, normalizedText: true, metadata: true, createdAt: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return { scan: progress, jobs };
}

export async function listRecentScans(userId: string, projectId: string, take = 5) {
  await requireProjectAccess(userId, projectId, "project:read");
  return db.scan.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take,
    select: { id: true, status: true, expectedQueryCount: true, completedCount: true, failedCount: true, skippedCount: true, actualCost: true, createdAt: true, completedAt: true },
  });
}
