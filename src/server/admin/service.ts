/**
 * Platform admin read models and controls. Every entry point checks
 * isPlatformAdmin on the database row (not the session) and answers NOT_FOUND
 * otherwise, so the admin area's existence isn't revealed. Demo data is
 * excluded from usage and cost figures.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { requirePlatformAdmin } from "@/server/auth/authorization";
import { getScanKillSwitch, setScanKillSwitch } from "@/server/system/settings";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { effectiveTier, tierName } from "@/server/billing/plans";
import { getProviderAvailability } from "@/server/providers/registry";
import { AppError } from "@/lib/errors";
import type { PlanTier, SubscriptionStatus } from "@/generated/prisma/enums";

const DAY = 86_400_000;
const LIST = 50;
const num = (d: { toNumber(): number } | null | undefined) => (d ? d.toNumber() : 0);
const contains = (q?: string) => (q ? { contains: q, mode: "insensitive" as const } : undefined);

export async function adminOverview(userId: string, now = new Date()) {
  await requirePlatformAdmin(userId);
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since1 = new Date(now.getTime() - DAY);
  const real = { isDemo: false };
  const [killSwitch, orgs, users, projects, scans24, failedJobs24, providers, availability, usage, usage24, onboarding, audits, subs, daily] = await Promise.all([
    getScanKillSwitch(),
    db.organization.count({ where: real }),
    db.user.count(),
    db.project.count({ where: { archivedAt: null, organization: real } }),
    db.scan.groupBy({ by: ["status"], where: { ...real, createdAt: { gte: since1 } }, _count: true }),
    db.scanJob.count({ where: { status: "FAILED", updatedAt: { gte: since1 }, scan: real } }),
    db.aIProvider.findMany({ orderBy: { slug: "asc" }, select: { id: true, slug: true, displayName: true, isEnabled: true, dailyQueryCap: true, requestsPerMinute: true, maxConcurrency: true } }),
    getProviderAvailability(),
    db.aIResponse.groupBy({ by: ["providerId"], where: { ...real, createdAt: { gte: since30 } }, _count: true, _sum: { estimatedCost: true, inputTokens: true, outputTokens: true } }),
    db.aIResponse.groupBy({ by: ["providerId"], where: { ...real, createdAt: { gte: since1 } }, _count: true, _sum: { estimatedCost: true } }),
    db.websiteAnalysis.aggregate({ where: { createdAt: { gte: since30 }, project: { organization: real } }, _count: true, _sum: { estimatedCost: true, inputTokens: true, outputTokens: true } }),
    db.publicAudit.groupBy({ by: ["status"], where: { createdAt: { gte: since30 } }, _count: true }),
    db.subscription.groupBy({ by: ["planTier", "status"], where: { organization: real }, _count: true }),
    db.$queryRaw<Array<{ day: Date; cost: number; answers: number }>>`
      SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM("estimatedCost"), 0)::float8 AS cost, COUNT(*)::int AS answers
      FROM "AIResponse" WHERE "isDemo" = false AND "createdAt" >= ${since30}
      GROUP BY 1 ORDER BY 1`,
  ]);
  // Public audit engine cost is stored on each audit's result.
  const auditCost = await db.$queryRaw<Array<{ cost: number; conversions: number }>>`
    SELECT COALESCE(SUM(("result"->>'costUsd')::numeric), 0)::float8 AS cost, COUNT(*) FILTER (WHERE "convertedTo" IS NOT NULL)::int AS conversions
    FROM "PublicAudit" WHERE "createdAt" >= ${since30}`;

  const ready = new Set(availability.ready.map((r) => r.slug));
  const unavailable = new Map(availability.unavailable.map((u) => [u.slug, u.reason]));
  const providerRows = providers.map((p) => {
    const u = usage.find((x) => x.providerId === p.id);
    const d = usage24.find((x) => x.providerId === p.id);
    return {
      ...p,
      ready: ready.has(p.slug),
      unavailableReason: unavailable.get(p.slug) ?? null,
      answers30d: u?._count ?? 0,
      cost30d: num(u?._sum.estimatedCost),
      tokens30d: (u?._sum.inputTokens ?? 0) + (u?._sum.outputTokens ?? 0),
      answers24h: d?._count ?? 0,
      cost24h: num(d?._sum.estimatedCost),
    };
  });
  const scanCost = providerRows.reduce((s, p) => s + p.cost30d, 0);
  const subscriptions = subs.map((s) => ({ tier: s.planTier, status: s.status, effective: effectiveTier(s), count: s._count }));
  return {
    killSwitch,
    counts: { orgs, users, projects, scans24h: scans24.reduce((n, s) => n + s._count, 0), failedScans24h: scans24.find((s) => s.status === "FAILED")?._count ?? 0, failedJobs24h: failedJobs24 },
    providers: providerRows,
    costs: {
      scans30d: scanCost,
      onboarding30d: num(onboarding._sum.estimatedCost),
      onboardingRuns30d: onboarding._count,
      audits30d: auditCost[0]?.cost ?? 0,
      total30d: scanCost + num(onboarding._sum.estimatedCost) + (auditCost[0]?.cost ?? 0),
      daily: daily.map((d) => ({ day: d.day.toISOString().slice(0, 10), cost: d.cost, answers: d.answers })),
    },
    audits: { byStatus: Object.fromEntries(audits.map((a) => [a.status, a._count])) as Record<string, number>, conversions30d: auditCost[0]?.conversions ?? 0 },
    subscriptions,
    paying: subscriptions.filter((s) => s.effective !== "FREE").reduce((n, s) => n + s.count, 0),
  };
}

export async function adminOrganizations(userId: string, q?: string) {
  await requirePlatformAdmin(userId);
  const rows = await db.organization.findMany({
    where: q ? { OR: [{ name: contains(q) }, { slug: contains(q) }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: LIST,
    select: { id: true, name: true, slug: true, isDemo: true, createdAt: true, subscription: { select: { planTier: true, status: true, stripeSubscriptionId: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } }, _count: { select: { members: true, projects: true } } },
  });
  return rows.map((o) => ({ ...o, effective: effectiveTier(o.subscription) }));
}

export async function adminUsers(userId: string, q?: string) {
  await requirePlatformAdmin(userId);
  return db.user.findMany({
    where: q ? { OR: [{ email: contains(q) }, { name: contains(q) }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: LIST,
    select: { id: true, name: true, email: true, isPlatformAdmin: true, createdAt: true, passwordHash: false, memberships: { select: { role: true, organization: { select: { slug: true, name: true } } } } },
  });
}

export async function adminProjects(userId: string, q?: string) {
  await requirePlatformAdmin(userId);
  return db.project.findMany({
    where: q ? { OR: [{ name: contains(q) }, { domain: contains(q) }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: LIST,
    select: {
      id: true, name: true, domain: true, country: true, onboardingStep: true, archivedAt: true, createdAt: true,
      organization: { select: { slug: true, name: true, isDemo: true } },
      _count: { select: { prompts: { where: { isActive: true } }, competitors: true, scans: true } },
      scans: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, status: true } },
    },
  });
}

export async function adminScans(userId: string, q?: string) {
  await requirePlatformAdmin(userId);
  return db.scan.findMany({
    where: q ? { OR: [{ id: q }, { project: { domain: contains(q) } }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: LIST,
    select: {
      id: true, status: true, scanType: true, isDemo: true, expectedQueryCount: true, completedCount: true, failedCount: true, skippedCount: true,
      estimatedCost: true, actualCost: true, analysisStatus: true, errorSummary: true, createdAt: true, completedAt: true,
      project: { select: { id: true, domain: true, organization: { select: { slug: true } } } },
    },
  });
}

export async function adminFailures(userId: string) {
  await requirePlatformAdmin(userId);
  const [jobs, scans, audits, byCode] = await Promise.all([
    db.scanJob.findMany({
      where: { status: "FAILED" },
      orderBy: { updatedAt: "desc" },
      take: LIST,
      select: { id: true, errorCode: true, lastError: true, attempts: true, updatedAt: true, scanId: true, provider: { select: { slug: true } }, prompt: { select: { text: true } }, scan: { select: { project: { select: { domain: true } } } } },
    }),
    db.scan.findMany({ where: { OR: [{ status: "FAILED" }, { analysisStatus: "FAILED" }] }, orderBy: { updatedAt: "desc" }, take: 20, select: { id: true, status: true, analysisStatus: true, errorSummary: true, analysisError: true, updatedAt: true, project: { select: { domain: true } } } }),
    db.publicAudit.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 20, select: { id: true, domain: true, result: true, updatedAt: true } }),
    db.scanJob.groupBy({ by: ["errorCode"], where: { status: "FAILED", updatedAt: { gte: new Date(Date.now() - 7 * DAY) } }, _count: true, orderBy: { _count: { errorCode: "desc" } }, take: 10 }),
  ]);
  return { jobs, scans, audits: audits.map((a) => ({ ...a, error: (a.result as { error?: string } | null)?.error ?? null })), byCode: byCode.map((c) => ({ code: c.errorCode ?? "UNKNOWN", count: c._count })) };
}

// ── Controls ─────────────────────────────────────────────────

export const killSwitchInput = z.object({ enabled: z.enum(["true", "false"]).transform((v) => v === "true"), reason: z.string().trim().max(200).optional() });

export async function adminSetKillSwitch(userId: string, raw: unknown) {
  await requirePlatformAdmin(userId);
  const input = killSwitchInput.parse(raw);
  if (input.enabled && !input.reason) throw new AppError("VALIDATION", "Give a reason so other admins know why scans are paused.");
  await setScanKillSwitch({ enabled: input.enabled, ...(input.reason ? { reason: input.reason } : {}) }, userId);
}

export async function adminSetProviderEnabled(userId: string, slug: string, enabled: boolean) {
  await requirePlatformAdmin(userId);
  const { count } = await db.aIProvider.updateMany({ where: { slug }, data: { isEnabled: enabled } });
  if (!count) throw new AppError("NOT_FOUND", "Provider not found.");
  await writeAuditLog({ actorId: userId, action: enabled ? "provider.enabled" : "provider.disabled", entityType: "AIProvider", entityId: slug });
}

export const subscriptionLabel = (tier: PlanTier, status: SubscriptionStatus) => `${tierName(tier)} · ${status.toLowerCase().replace("_", " ")}`;
