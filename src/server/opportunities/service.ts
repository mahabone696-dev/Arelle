/**
 * Opportunities, recommendations and action tracking.
 *
 * - evaluateProject: runs the rules on the last 30 days of answers and syncs
 *   Opportunity/Recommendation rows by fingerprint (repeated scans update,
 *   never duplicate; dismissals stick; what's no longer detected is RESOLVED).
 * - Recommendation flow: OPEN → PLANNED → IMPLEMENTED (or DISMISSED).
 * - measureActionsForScan: after each analyzed scan, records the observed
 *   before/after visibility for implemented actions. Observation, not causation.
 */
import { z } from "zod";
import { db } from "@/server/db";
import type { Prisma } from "@/generated/prisma/client";
import type { OpportunityStatus, OpportunityType, RecommendationStatus } from "@/generated/prisma/enums";
import { requireProjectAccess } from "@/server/auth/authorization";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { resolveWeights } from "@/server/scoring/visibility";
import { subjectMetrics } from "@/server/dashboard/aggregate";
import { loadProjectAnswers } from "@/server/dashboard/answers";
import { AppError } from "@/lib/errors";
import { assertFeature } from "@/server/billing/limits";
import { logger } from "@/lib/logger";
import { detectOpportunities, type OpportunityEvidence } from "./rules";
import { recommend } from "./recommend";
import type { SitePage } from "./pages";

const log = logger.child({ module: "opportunities" });
const DAY = 86_400_000;
/** Opportunities are evaluated on, and before/after scores use, 30-day windows. */
export const WINDOW_DAYS = 30;

async function projectInputs(projectId: string) {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      domain: true,
      organizationId: true,
      organization: { select: { isDemo: true } },
      brand: { select: { name: true, domain: true, industry: true } },
      competitors: { where: { isActive: true }, select: { id: true, name: true, domain: true }, orderBy: { createdAt: "asc" } },
      prompts: { where: { isActive: true }, select: { id: true, text: true, intent: true, priority: true } },
      websiteAnalyses: { where: { status: "COMPLETED" }, orderBy: { createdAt: "desc" }, take: 1, select: { pages: true } },
    },
  });
  const pages = project.websiteAnalyses[0] ? (project.websiteAnalyses[0].pages as unknown as SitePage[]) : null;
  return {
    project,
    isDemo: project.organization.isDemo,
    brand: { name: project.brand?.name ?? project.name, domain: project.brand?.domain ?? project.domain, industry: project.brand?.industry ?? null },
    pages: pages && pages.length ? pages : null,
  };
}

export interface EvaluationResult {
  detected: number;
  created: number;
  updated: number;
  resolved: number;
  reopened: number;
}

/**
 * Re-evaluate a project's opportunities as of `asOf` (default now).
 * With no analyzed answers in the window nothing changes — missing data never
 * resolves opportunities.
 */
export async function evaluateProject(projectId: string, options: { asOf?: Date; scanId?: string | null } = {}): Promise<EvaluationResult | null> {
  const asOf = options.asOf ?? new Date();
  const inputs = await projectInputs(projectId);
  const answers = await loadProjectAnswers(projectId, inputs.isDemo, new Date(asOf.getTime() - WINDOW_DAYS * DAY), new Date(asOf.getTime() + 1));
  if (!answers.length) return null;
  const { project, brand, pages } = inputs;
  const drafts = detectOpportunities({ brand, competitors: project.competitors, prompts: project.prompts, answers, pages, weights: resolveWeights() });
  const promptById = new Map(project.prompts.map((p) => [p.id, p]));

  const result: EvaluationResult = { detected: drafts.length, created: 0, updated: 0, resolved: 0, reopened: 0 };
  await db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`opportunities:${projectId}`}))::text AS locked`;
      const existing = new Map((await tx.opportunity.findMany({ where: { projectId }, select: { id: true, fingerprint: true, status: true } })).map((o) => [o.fingerprint, o]));
      const seen = new Set<string>();
      // The same page or outreach can come out of several opportunities; only the highest-impact one carries it.
      const claimed = new Map<string, { fingerprint: string; title: string }>();
      for (const d of drafts) {
        seen.add(d.fingerprint);
        const prev = existing.get(d.fingerprint);
        const coveredBy: { fingerprint: string; title: string }[] = [];
        const recs = recommend(d, { brand, competitors: project.competitors, prompt: d.promptId ? promptById.get(d.promptId) : null }).filter((r) => {
          const key = `${r.type}|${r.targetUrl ?? r.title}`;
          const owner = claimed.get(key);
          if (owner) {
            if (!coveredBy.some((c) => c.fingerprint === owner.fingerprint)) coveredBy.push(owner);
            return false;
          }
          claimed.set(key, { fingerprint: d.fingerprint, title: d.title });
          return true;
        });
        const data = {
          type: d.type,
          promptId: d.promptId,
          scanId: options.scanId ?? null,
          title: d.title,
          description: d.description,
          evidence: { ...d.evidence, ...(coveredBy.length ? { coveredBy } : {}) } as unknown as Prisma.InputJsonValue,
          impactScore: d.impactScore,
          confidenceScore: d.confidenceScore,
          lastDetectedAt: asOf,
        };
        let opportunityId: string;
        if (!prev) {
          opportunityId = (await tx.opportunity.create({ data: { ...data, projectId, fingerprint: d.fingerprint }, select: { id: true } })).id;
          result.created++;
        } else {
          // Dismissed stays dismissed (evidence still refreshed); resolved comes back if detected again.
          const reopen = prev.status === "RESOLVED";
          await tx.opportunity.update({ where: { id: prev.id }, data: { ...data, ...(reopen ? { status: "OPEN" as const, resolvedAt: null } : {}) } });
          opportunityId = prev.id;
          if (reopen) result.reopened++;
          else result.updated++;
        }
        await syncRecommendations(tx, opportunityId, recs);
      }
      const stale = [...existing.values()].filter((o) => o.status === "OPEN" && !seen.has(o.fingerprint)).map((o) => o.id);
      if (stale.length) result.resolved = (await tx.opportunity.updateMany({ where: { id: { in: stale } }, data: { status: "RESOLVED", resolvedAt: asOf } })).count;
    },
    { timeout: 30_000 },
  );
  log.info("opportunities.evaluated", { projectId, ...result });
  return result;
}

type Tx = Prisma.TransactionClient;

/** Upsert by (opportunity, type). Only OPEN recommendations are rewritten; anything the user acted on is left alone. */
async function syncRecommendations(tx: Tx, opportunityId: string, drafts: ReturnType<typeof recommend>) {
  const existing = new Map((await tx.recommendation.findMany({ where: { opportunityId }, select: { id: true, type: true, status: true, _count: { select: { actions: true } } } })).map((r) => [r.type, r]));
  for (const r of drafts) {
    const prev = existing.get(r.type);
    const data = { title: r.title, reason: r.reason, targetUrl: r.targetUrl, suggestedAction: r.suggestedAction, estimatedImpact: r.estimatedImpact };
    if (!prev) await tx.recommendation.create({ data: { ...data, opportunityId, type: r.type } });
    else if (prev.status === "OPEN") await tx.recommendation.update({ where: { id: prev.id }, data });
  }
  // Templates can change with the evidence (e.g. a page now exists): drop untouched OPEN ones no longer suggested.
  const wanted = new Set(drafts.map((r) => r.type));
  const obsolete = [...existing.values()].filter((r) => !wanted.has(r.type) && r.status === "OPEN" && r._count.actions === 0).map((r) => r.id);
  if (obsolete.length) await tx.recommendation.deleteMany({ where: { id: { in: obsolete } } });
}

// ── Scope & scores ────────────────────────────────────────────

/** Prompts an opportunity is about; [] means the whole project. */
function scopeOf(o: { promptId: string | null; evidence: Prisma.JsonValue }): string[] {
  if (o.promptId) return [o.promptId];
  const ids = (o.evidence as OpportunityEvidence | null)?.promptIds;
  return Array.isArray(ids) ? ids : [];
}

async function scopeScore(projectId: string, isDemo: boolean, scope: string[], from: Date, to: Date) {
  const answers = await loadProjectAnswers(projectId, isDemo, from, to, scope.length ? { promptIds: scope } : {});
  return { answers: answers.length, score: answers.length ? subjectMetrics(answers, null, resolveWeights()).visibilityScore : null };
}

// ── Recommendation flow ───────────────────────────────────────

async function loadRecommendation(userId: string, projectId: string, recommendationId: string, permission: "project:read" | "action:update") {
  const access = await requireProjectAccess(userId, projectId, permission);
  // Recommendations and action tracking are a paid feature (Action Engine).
  await assertFeature(access.organizationId, "actionEngine");
  const rec = await db.recommendation.findFirst({
    where: { id: recommendationId, opportunity: { projectId } },
    include: { opportunity: true, actions: { orderBy: { createdAt: "desc" }, include: { measurements: { orderBy: { measuredAt: "asc" } } } } },
  });
  if (!rec) throw new AppError("NOT_FOUND", "Recommendation not found.");
  return { access, rec };
}

/** Lock the recommendation row and re-read its state, so concurrent clicks can't create two actions. */
async function lockedState(tx: Tx, recommendationId: string) {
  await tx.$queryRaw`SELECT id FROM "Recommendation" WHERE id = ${recommendationId} FOR UPDATE`;
  const r = await tx.recommendation.findUniqueOrThrow({ where: { id: recommendationId }, select: { status: true, actions: { where: { status: { not: "ABANDONED" } }, select: { id: true, status: true }, take: 1 } } });
  if (r.status === "IMPLEMENTED") throw new AppError("CONFLICT", "This recommendation is already marked as implemented.");
  return { status: r.status, active: r.actions[0] ?? null };
}

export async function planRecommendation(userId: string, projectId: string, recommendationId: string) {
  const { access, rec } = await loadRecommendation(userId, projectId, recommendationId, "action:update");
  if (rec.status === "IMPLEMENTED") throw new AppError("CONFLICT", "This recommendation is already marked as implemented.");
  await db.$transaction(async (tx) => {
    const { active } = await lockedState(tx, recommendationId);
    if (!active) await tx.action.create({ data: { recommendationId, status: "PLANNED", createdById: userId } });
    await tx.recommendation.update({ where: { id: recommendationId }, data: { status: "PLANNED" } });
    await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "recommendation.planned", entityType: "Recommendation", entityId: recommendationId }, tx);
  });
}

export const implementSchema = z.object({
  implementedAt: z.coerce.date(),
  implementationUrl: z
    .string()
    .trim()
    .max(2048)
    .url("Enter a full URL, e.g. https://example.com/page")
    .refine((u) => /^https?:\/\//i.test(u), "Only http(s) URLs")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
});

export async function implementRecommendation(userId: string, projectId: string, recommendationId: string, raw: unknown, now = new Date()) {
  const input = implementSchema.parse(raw);
  if (input.implementedAt.getTime() > now.getTime() + 60_000) throw new AppError("VALIDATION", "The implementation date can't be in the future.");
  if (input.implementedAt.getTime() < now.getTime() - 365 * DAY) throw new AppError("VALIDATION", "The implementation date must be within the last year.");
  const { access, rec } = await loadRecommendation(userId, projectId, recommendationId, "action:update");
  if (rec.status === "IMPLEMENTED") throw new AppError("CONFLICT", "This recommendation is already marked as implemented.");
  const { isDemo } = await projectInputs(projectId);
  const scope = scopeOf(rec.opportunity);
  const before = await scopeScore(projectId, isDemo, scope, new Date(input.implementedAt.getTime() - WINDOW_DAYS * DAY), input.implementedAt);
  const data = {
    status: "IMPLEMENTED" as const,
    implementedAt: input.implementedAt,
    implementationUrl: input.implementationUrl ?? null,
    notes: input.notes ?? null,
    baselineScore: before.score,
    baselineAnswers: before.answers,
    scopePromptIds: scope,
  };
  const action = await db.$transaction(async (tx) => {
    const { active: current } = await lockedState(tx, recommendationId);
    const a = current ? await tx.action.update({ where: { id: current.id }, data }) : await tx.action.create({ data: { ...data, recommendationId, createdById: userId } });
    await tx.recommendation.update({ where: { id: recommendationId }, data: { status: "IMPLEMENTED" } });
    await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "recommendation.implemented", entityType: "Action", entityId: a.id, metadata: { recommendationId, implementedAt: input.implementedAt.toISOString(), baselineScore: before.score } }, tx);
    return a;
  });
  // A backdated implementation can already have scans after it.
  await backfillMeasurements(action.id);
  return action;
}

export async function setRecommendationStatus(userId: string, projectId: string, recommendationId: string, status: Extract<RecommendationStatus, "OPEN" | "DISMISSED">) {
  const { access, rec } = await loadRecommendation(userId, projectId, recommendationId, "action:update");
  if (rec.status === "IMPLEMENTED") throw new AppError("CONFLICT", "Implemented recommendations keep their history and can't be changed.");
  await db.$transaction(async (tx) => {
    // A plan that's dismissed or reopened is abandoned; implemented actions are never touched.
    await tx.action.updateMany({ where: { recommendationId, status: "PLANNED" }, data: { status: "ABANDONED" } });
    await tx.recommendation.update({ where: { id: recommendationId }, data: { status } });
    await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: status === "DISMISSED" ? "recommendation.dismissed" : "recommendation.reopened", entityType: "Recommendation", entityId: recommendationId }, tx);
  });
}

export async function setOpportunityStatus(userId: string, projectId: string, opportunityId: string, status: Extract<OpportunityStatus, "OPEN" | "DISMISSED">) {
  const access = await requireProjectAccess(userId, projectId, "action:update");
  const o = await db.opportunity.findFirst({ where: { id: opportunityId, projectId }, select: { id: true, status: true } });
  if (!o) throw new AppError("NOT_FOUND", "Opportunity not found.");
  if (o.status === "RESOLVED" && status === "OPEN") throw new AppError("CONFLICT", "This opportunity is no longer detected in recent answers.");
  await db.opportunity.update({ where: { id: opportunityId }, data: { status, dismissedAt: status === "DISMISSED" ? new Date() : null } });
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: status === "DISMISSED" ? "opportunity.dismissed" : "opportunity.restored", entityType: "Opportunity", entityId: opportunityId });
}

// ── Measurements ──────────────────────────────────────────────

/**
 * Observed change for one implemented action as of a scan: visibility of the
 * action's scope over answers after implementation (last 30 days at most)
 * vs. the baseline before it. Idempotent per (action, scan).
 */
async function measure(action: { id: string; implementedAt: Date | null; baselineScore: number | null; scopePromptIds: string[] }, scan: { id: string; projectId: string; completedAt: Date | null }, isDemo: boolean) {
  if (!action.implementedAt || action.baselineScore === null || !scan.completedAt || scan.completedAt <= action.implementedAt) return false;
  const from = new Date(Math.max(action.implementedAt.getTime(), scan.completedAt.getTime() - WINDOW_DAYS * DAY));
  const after = await scopeScore(scan.projectId, isDemo, action.scopePromptIds, from, new Date(scan.completedAt.getTime() + 1));
  if (after.score === null) return false;
  const delta = Math.round((after.score - action.baselineScore) * 10) / 10;
  const { count } = await db.actionMeasurement.createMany({
    data: [
      {
        actionId: action.id,
        scanId: scan.id,
        measuredAt: scan.completedAt,
        daysSinceImplementation: Math.floor((scan.completedAt.getTime() - action.implementedAt.getTime()) / DAY),
        beforeScore: action.baselineScore,
        afterScore: after.score,
        delta,
        afterAnswers: after.answers,
      },
    ],
    skipDuplicates: true,
  });
  return count > 0;
}

export async function measureActionsForScan(scanId: string): Promise<number> {
  const scan = await db.scan.findUnique({ where: { id: scanId }, select: { id: true, projectId: true, completedAt: true, isDemo: true, analysisStatus: true } });
  if (!scan || scan.analysisStatus !== "COMPLETED") return 0;
  const actions = await db.action.findMany({ where: { status: "IMPLEMENTED", recommendation: { opportunity: { projectId: scan.projectId } } }, select: { id: true, implementedAt: true, baselineScore: true, scopePromptIds: true } });
  let n = 0;
  for (const a of actions) if (await measure(a, scan, scan.isDemo)) n++;
  return n;
}

/** Measurements for analyzed scans that already exist after a (backdated) implementation date — the 10 most recent. */
export async function backfillMeasurements(actionId: string) {
  const action = await db.action.findUniqueOrThrow({ where: { id: actionId }, select: { id: true, implementedAt: true, baselineScore: true, scopePromptIds: true, recommendation: { select: { opportunity: { select: { projectId: true, project: { select: { organization: { select: { isDemo: true } } } } } } } } } });
  if (!action.implementedAt) return 0;
  const { projectId, project } = action.recommendation.opportunity;
  const scans = await db.scan.findMany({ where: { projectId, analysisStatus: "COMPLETED", completedAt: { gt: action.implementedAt } }, orderBy: { completedAt: "desc" }, take: 10, select: { id: true, projectId: true, completedAt: true } });
  let n = 0;
  for (const s of scans.reverse()) if (await measure(action, s, project.organization.isDemo)) n++;
  return n;
}

/** Runs after a scan's analysis completes (worker). Idempotent, safe to retry. */
export async function afterScanAnalyzed(scanId: string) {
  const scan = await db.scan.findUnique({ where: { id: scanId }, select: { projectId: true, completedAt: true, analysisStatus: true } });
  if (!scan || scan.analysisStatus !== "COMPLETED") return null;
  const evaluation = await evaluateProject(scan.projectId, { scanId, asOf: scan.completedAt ?? new Date() });
  const measured = await measureActionsForScan(scanId);
  return { evaluation, measured };
}

// ── Read models ───────────────────────────────────────────────

/** Opportunities about prompts you've stopped tracking are hidden (they'd otherwise read as "no longer detected"). */
const TRACKED = { OR: [{ promptId: null }, { prompt: { isActive: true } }] } satisfies Prisma.OpportunityWhereInput;

export async function listOpportunities(userId: string, projectId: string, filter: { status?: OpportunityStatus; type?: OpportunityType } = {}) {
  await requireProjectAccess(userId, projectId, "project:read");
  return db.opportunity.findMany({
    where: { projectId, status: filter.status ?? "OPEN", ...(filter.type ? { type: filter.type } : {}), ...TRACKED },
    orderBy: [{ impactScore: "desc" }, { createdAt: "asc" }],
    include: { prompt: { select: { id: true, text: true, intent: true } }, recommendations: { select: { id: true, type: true, title: true, status: true, estimatedImpact: true }, orderBy: { createdAt: "asc" } } },
  });
}

export async function opportunityCounts(userId: string, projectId: string) {
  await requireProjectAccess(userId, projectId, "project:read");
  const rows = await db.opportunity.groupBy({ by: ["status"], where: { projectId, ...TRACKED }, _count: true });
  return Object.fromEntries(rows.map((r) => [r.status, r._count])) as Partial<Record<OpportunityStatus, number>>;
}

export async function listRecommendations(userId: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  await assertFeature(access.organizationId, "actionEngine");
  return db.recommendation.findMany({
    where: { opportunity: { projectId } },
    orderBy: [{ opportunity: { impactScore: "desc" } }, { createdAt: "asc" }],
    include: {
      opportunity: { select: { id: true, type: true, title: true, status: true, impactScore: true, prompt: { select: { id: true, text: true } } } },
      actions: { where: { status: { not: "ABANDONED" } }, orderBy: { createdAt: "desc" }, take: 1, include: { measurements: { orderBy: { measuredAt: "desc" }, take: 1 } } },
    },
  });
}

export async function getRecommendation(userId: string, projectId: string, recommendationId: string) {
  const { access, rec } = await loadRecommendation(userId, projectId, recommendationId, "project:read");
  const prompt = rec.opportunity.promptId ? await db.prompt.findUnique({ where: { id: rec.opportunity.promptId }, select: { id: true, text: true, intent: true } }) : null;
  const siblings = await db.recommendation.findMany({ where: { opportunityId: rec.opportunityId, id: { not: rec.id } }, select: { id: true, title: true, type: true, status: true } });
  return { rec, prompt, siblings, role: access.role };
}

/** Top OPEN opportunities with their first recommendation (overview). */
export async function topOpportunities(userId: string, projectId: string, take = 5) {
  await requireProjectAccess(userId, projectId, "project:read");
  const [items, total] = await Promise.all([
    db.opportunity.findMany({
      where: { projectId, status: "OPEN", ...TRACKED },
      orderBy: [{ impactScore: "desc" }, { createdAt: "asc" }],
      take,
      include: { recommendations: { where: { status: { not: "DISMISSED" } }, orderBy: { createdAt: "asc" }, take: 1, select: { id: true } } },
    }),
    db.opportunity.groupBy({ by: ["type"], where: { projectId, status: "OPEN", ...TRACKED }, _count: true }),
  ]);
  return { items, byType: Object.fromEntries(total.map((t) => [t.type, t._count])) as Partial<Record<OpportunityType, number>> };
}

/** Highest-impact OPEN opportunity per prompt (prompts table). */
export async function promptOpportunities(userId: string, projectId: string) {
  await requireProjectAccess(userId, projectId, "project:read");
  const rows = await db.opportunity.findMany({ where: { projectId, status: "OPEN", promptId: { not: null } }, orderBy: { impactScore: "desc" }, select: { promptId: true, impactScore: true, type: true } });
  const out = new Map<string, { impactScore: number; type: OpportunityType }>();
  for (const r of rows) if (!out.has(r.promptId!)) out.set(r.promptId!, { impactScore: r.impactScore, type: r.type });
  return out;
}

/** Recommendations for one prompt's open opportunities (prompt detail). */
export async function recommendationsForPrompt(userId: string, projectId: string, promptId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  await assertFeature(access.organizationId, "actionEngine");
  return db.recommendation.findMany({
    // Open work for opportunities still detected, plus anything already planned or implemented.
    where: { opportunity: { projectId, promptId }, OR: [{ status: "OPEN", opportunity: { status: "OPEN" } }, { status: { in: ["PLANNED", "IMPLEMENTED"] } }] },
    orderBy: [{ opportunity: { impactScore: "desc" } }, { createdAt: "asc" }],
    select: { id: true, type: true, title: true, reason: true, targetUrl: true, status: true, estimatedImpact: true, opportunity: { select: { status: true } } },
  });
}
