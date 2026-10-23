/**
 * Plan catalog and limits. Every limit is enforced server-side (scan
 * admission, the worker's runtime quota, project creation, prompt approval,
 * feature gates); the UI only mirrors them.
 */
import type { PlanTier, SubscriptionStatus } from "@/generated/prisma/enums";

export interface PlanLimits {
  projects: number;
  /** Active prompts that may be scanned per project. */
  prompts: number;
  /** Minimum hours between scans of the same project ("weekly" / "daily" cadence). */
  minHoursBetweenScans: number;
  /** User-triggered scans per organization per UTC day. */
  manualScansPerDay: number;
  /** Provider queries per organization per UTC day (hard cap). */
  queriesPerDay: number;
  /** Provider queries per organization per calendar month (UTC). */
  queriesPerMonth: number;
  /** Recommendations, action tracking and before/after measurement. */
  actionEngine: boolean;
  /** Reports & share links (Phase 9) and team features. */
  reports: boolean;
}

export interface PlanInfo {
  tier: PlanTier;
  name: string;
  /** List price in USD per month (display only — Stripe prices are the source of truth for billing). */
  priceUsd: number;
  cadence: string;
  limits: PlanLimits;
}

export const PLANS: Record<PlanTier, PlanInfo> = {
  FREE: {
    tier: "FREE",
    name: "Free",
    priceUsd: 0,
    cadence: "1 scan per week",
    limits: { projects: 1, prompts: 10, minHoursBetweenScans: 7 * 24, manualScansPerDay: 1, queriesPerDay: 50, queriesPerMonth: 150, actionEngine: false, reports: false },
  },
  STARTER: {
    tier: "STARTER",
    name: "Starter",
    priceUsd: 49,
    cadence: "Weekly scans",
    limits: { projects: 1, prompts: 50, minHoursBetweenScans: 7 * 24, manualScansPerDay: 3, queriesPerDay: 300, queriesPerMonth: 1_000, actionEngine: false, reports: false },
  },
  GROWTH: {
    tier: "GROWTH",
    name: "Growth",
    priceUsd: 149,
    cadence: "Daily scans",
    // 20 h (not 24) so a scan can run at roughly the same time every day.
    limits: { projects: 3, prompts: 200, minHoursBetweenScans: 20, manualScansPerDay: 10, queriesPerDay: 2_000, queriesPerMonth: 25_000, actionEngine: true, reports: false },
  },
  AGENCY: {
    tier: "AGENCY",
    name: "Agency",
    priceUsd: 499,
    cadence: "Daily scans",
    limits: { projects: 10, prompts: 1_000, minHoursBetweenScans: 20, manualScansPerDay: 50, queriesPerDay: 10_000, queriesPerMonth: 100_000, actionEngine: true, reports: true },
  },
};

export const PAID_TIERS = ["STARTER", "GROWTH", "AGENCY"] as const satisfies readonly PlanTier[];
export type PaidTier = (typeof PAID_TIERS)[number];

/** Back-compat alias used by earlier phases. */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, v.limits])) as Record<PlanTier, PlanLimits>;

/** Statuses that keep paid features: past-due is a grace period while Stripe retries the payment. */
const ENTITLED: ReadonlySet<SubscriptionStatus> = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

/** The tier whose limits apply right now: canceled, unpaid or incomplete subscriptions fall back to Free. */
export function effectiveTier(sub: { planTier: PlanTier; status: SubscriptionStatus } | null | undefined): PlanTier {
  if (!sub) return "FREE";
  return ENTITLED.has(sub.status) ? sub.planTier : "FREE";
}

export function planLimits(tier: PlanTier | null | undefined): PlanLimits {
  return PLAN_LIMITS[tier ?? "FREE"];
}

export const tierName = (tier: PlanTier) => PLANS[tier].name;

/** Lowest tier that has a feature (for upgrade prompts). */
export function lowestTierWith(feature: keyof Pick<PlanLimits, "actionEngine" | "reports">): PlanTier {
  return (["FREE", ...PAID_TIERS] as PlanTier[]).find((t) => PLANS[t].limits[feature])!;
}
