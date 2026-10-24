/**
 * Server-side plan enforcement helpers. Everything that spends money or
 * creates billable resources goes through here.
 */
import { db } from "@/server/db";
import type { Prisma } from "@/generated/prisma/client";
import { AppError } from "@/lib/errors";
import { effectiveTier, lowestTierWith, PLANS, planLimits, tierName, type PlanLimits } from "./plans";
import type { PlanTier } from "@/generated/prisma/enums";

type Client = Prisma.TransactionClient | typeof db;

export async function getOrgPlan(organizationId: string, client: Client = db): Promise<{ tier: PlanTier; limits: PlanLimits }> {
  const sub = await client.subscription.findUnique({ where: { organizationId }, select: { planTier: true, status: true } });
  const tier = effectiveTier(sub);
  return { tier, limits: planLimits(tier) };
}

export const utcMonthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** Planned (admitted, not skipped) provider queries for an organization since `since`. */
export function plannedQueries(client: Client, organizationId: string, since: Date) {
  return client.scanJob.count({ where: { createdAt: { gte: since }, status: { not: "SKIPPED" }, scan: { project: { organizationId }, isDemo: false } } });
}

/** Throw a LIMIT_EXCEEDED that the UI can turn into an upgrade prompt. */
export function limitError(message: string, details: { limit: string; tier: PlanTier; [k: string]: unknown }) {
  return new AppError("LIMIT_EXCEEDED", message, { ...details, upgrade: true });
}

/**
 * Project count. Call inside the creating transaction, after taking the
 * org's advisory lock, so two concurrent creations can't both pass.
 */
export async function assertCanCreateProject(tx: Prisma.TransactionClient, organizationId: string, domain?: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`projects:${organizationId}`}))::text AS locked`;
  // A duplicate is the more useful answer than "upgrade" when the site is already tracked.
  if (domain && (await tx.project.findFirst({ where: { organizationId, domain }, select: { id: true } }))) {
    throw new AppError("CONFLICT", "A project for this domain already exists in this organization.");
  }
  const { tier, limits } = await getOrgPlan(organizationId, tx);
  const count = await tx.project.count({ where: { organizationId } });
  if (count >= limits.projects) {
    throw limitError(`Your ${tierName(tier)} plan includes ${limits.projects} project${limits.projects === 1 ? "" : "s"}. Upgrade to add another website.`, { limit: "projects", tier, max: limits.projects, used: count });
  }
}

/**
 * Projects that may be scanned: after a downgrade, only the oldest projects up
 * to the plan's limit keep scanning (the rest stay readable).
 */
export async function assertProjectWithinPlan(client: Client, organizationId: string, projectId: string, tier: PlanTier, limits: PlanLimits) {
  const allowed = await client.project.findMany({ where: { organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: limits.projects, select: { id: true } });
  if (!allowed.some((p) => p.id === projectId)) {
    throw limitError(`Your ${tierName(tier)} plan scans ${limits.projects} project${limits.projects === 1 ? "" : "s"}; this one is over the limit. Upgrade to scan it again.`, { limit: "projects", tier, max: limits.projects });
  }
}

/** Feature gate for paid features (Action Engine, reports). */
export async function assertFeature(organizationId: string, feature: "actionEngine" | "reports") {
  const { tier, limits } = await getOrgPlan(organizationId);
  if (!limits[feature]) {
    const needed = lowestTierWith(feature);
    throw new AppError("FEATURE_DISABLED", `${feature === "actionEngine" ? "Recommendations and action tracking are" : "Reports are"} included from the ${tierName(needed)} plan.`, { feature, tier, needed, upgrade: true });
  }
  return { tier, limits };
}

export async function hasFeature(organizationId: string, feature: "actionEngine" | "reports") {
  return (await getOrgPlan(organizationId)).limits[feature];
}

export { PLANS };
