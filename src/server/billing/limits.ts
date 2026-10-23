import { db } from "@/server/db";
import { planLimits, type PlanLimits } from "./plans";
import type { PlanTier } from "@/generated/prisma/enums";

export async function getOrgPlan(organizationId: string): Promise<{ tier: PlanTier; limits: PlanLimits }> {
  const sub = await db.subscription.findUnique({ where: { organizationId }, select: { planTier: true } });
  const tier = sub?.planTier ?? "FREE";
  return { tier, limits: planLimits(tier) };
}
