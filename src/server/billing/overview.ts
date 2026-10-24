/** Read model for the billing page: plan, subscription state and usage against limits. */
import { db } from "@/server/db";
import { requireOrgAccess } from "@/server/auth/authorization";
import { can } from "@/server/auth/policy";
import { utcDayStart } from "@/server/scans/config";
import { getOrgPlan, plannedQueries, utcMonthStart } from "./limits";
import { PLANS } from "./plans";
import { billingAvailability } from "./stripe";

export async function getBillingOverview(userId: string, orgSlug: string) {
  const access = await requireOrgAccess(userId, { slug: orgSlug }, "org:read");
  const organizationId = access.organizationId;
  const [{ tier, limits }, sub, projects, availability, queriesToday, queriesMonth, scansToday] = await Promise.all([
    getOrgPlan(organizationId),
    db.subscription.findUnique({ where: { organizationId }, select: { planTier: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, stripeCustomerId: true, stripeSubscriptionId: true } }),
    db.project.findMany({ where: { organizationId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true, domain: true, _count: { select: { prompts: { where: { isActive: true } } } } } }),
    billingAvailability(),
    plannedQueries(db, organizationId, utcDayStart()),
    plannedQueries(db, organizationId, utcMonthStart()),
    db.scan.count({ where: { project: { organizationId }, scanType: "MANUAL", isDemo: false, createdAt: { gte: utcDayStart() }, status: { notIn: ["FAILED", "CANCELLED"] } } }),
  ]);
  return {
    organizationId,
    organizationSlug: access.organizationSlug,
    canManage: can(access.role, "billing:manage"),
    tier,
    plan: PLANS[tier],
    /** The plan paid for, which can differ from the effective tier (e.g. canceled → Free). */
    subscription: sub,
    availability,
    usage: {
      projects: { used: projects.length, limit: limits.projects },
      projectList: projects.map((p, i) => ({ id: p.id, name: p.name, domain: p.domain, activePrompts: p._count.prompts, overPromptLimit: p._count.prompts > limits.prompts, scanning: i < limits.projects })),
      queriesToday: { used: queriesToday, limit: limits.queriesPerDay },
      queriesMonth: { used: queriesMonth, limit: limits.queriesPerMonth },
      manualScansToday: { used: scansToday, limit: limits.manualScansPerDay },
    },
  };
}
