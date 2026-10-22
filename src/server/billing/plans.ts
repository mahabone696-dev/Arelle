/**
 * Plan limits, enforced server-side. Stripe wiring arrives in Phase 8; the
 * limits that protect AI spend are enforced from Phase 3 on.
 */
import type { PlanTier } from "@/generated/prisma/enums";

export interface PlanLimits {
  projects: number;
  /** Active prompts that may be scanned per project. */
  prompts: number;
  /** User-triggered scans per organization per UTC day. */
  manualScansPerDay: number;
  /** Provider queries per organization per UTC day (hard cap). */
  queriesPerDay: number;
}

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE: { projects: 1, prompts: 10, manualScansPerDay: 1, queriesPerDay: 50 },
  STARTER: { projects: 1, prompts: 50, manualScansPerDay: 3, queriesPerDay: 300 },
  GROWTH: { projects: 3, prompts: 200, manualScansPerDay: 10, queriesPerDay: 2_000 },
  AGENCY: { projects: 10, prompts: 1_000, manualScansPerDay: 50, queriesPerDay: 10_000 },
};

export function planLimits(tier: PlanTier | null | undefined): PlanLimits {
  return PLAN_LIMITS[tier ?? "FREE"];
}
