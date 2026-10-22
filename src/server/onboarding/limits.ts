/**
 * Abuse and cost guards for onboarding. Applied server-side before any crawl
 * or paid AI call. Plan-based limits replace the constants in Phase 8.
 */
import { db } from "@/server/db";
import { AppError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { utcDayKey } from "./usage";

export const ONBOARDING_LIMITS = {
  analysesPerUserPerHour: 10,
  analysesPerOrgPerDay: 30,
  aiCallsPerOrgPerDay: 120,
  generationsPerUserPerHour: 30,
} as const;

export async function assertCanAnalyze(userId: string, organizationId: string): Promise<void> {
  const hourly = await rateLimit(`onboarding:analyze:${userId}`, ONBOARDING_LIMITS.analysesPerUserPerHour, 60 * 60 * 1000);
  if (!hourly.allowed) throw new AppError("LIMIT_EXCEEDED", "You've analyzed several websites recently. Try again in a little while.");
  const since = new Date(`${utcDayKey()}T00:00:00.000Z`);
  const today = await db.websiteAnalysis.count({ where: { project: { organizationId }, createdAt: { gte: since } } });
  if (today >= ONBOARDING_LIMITS.analysesPerOrgPerDay) {
    throw new AppError("LIMIT_EXCEEDED", "Your organization has reached today's website analysis limit.");
  }
}

export async function assertCanGenerate(userId: string): Promise<void> {
  const hourly = await rateLimit(`onboarding:generate:${userId}`, ONBOARDING_LIMITS.generationsPerUserPerHour, 60 * 60 * 1000);
  if (!hourly.allowed) throw new AppError("LIMIT_EXCEEDED", "Too many generation requests. Try again in a little while.");
}

/** True when the org may still make paid AI calls today; otherwise callers use the labelled fallback. */
export async function withinAiBudget(organizationId: string): Promise<boolean> {
  const agg = await db.usageRecord.aggregate({
    where: { organizationId, metric: "AI_EXTRACTION", periodKey: utcDayKey() },
    _sum: { quantity: true },
  });
  return (agg._sum.quantity ?? 0) < ONBOARDING_LIMITS.aiCallsPerOrgPerDay;
}
