/**
 * Dashboard read models. Each entry point authorizes, loads the analyzed
 * answers in the date window, and delegates every calculation to the pure
 * functions in ./aggregate (same scoring as the scan snapshots).
 */
import { db } from "@/server/db";
import { requireProjectAccess } from "@/server/auth/authorization";
import { loadProjectAnswers, type AnswerFilter } from "./answers";
import { getProviderAvailability, UNAVAILABLE_LABELS } from "@/server/providers/registry";
import { resolveWeights, scoreDelta, type VisibilityMetrics } from "@/server/scoring/visibility";
import type { PromptIntent } from "@/generated/prisma/enums";
import { AppError } from "@/lib/errors";
import { resolveDateWindow, type DateRangeKey } from "@/lib/date-range";
import {
  citationDomains,
  dailySeries,
  groupBy,
  latestPerProvider,
  promptRows,
  promptsCompetitorWins,
  subjectMetrics,
  whyLosing,
  type AnswerRow,
  type PromptStatus,
} from "./aggregate";

async function projectContext(userId: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      domain: true,
      organization: { select: { isDemo: true } },
      brand: { select: { name: true } },
      competitors: { where: { isActive: true }, select: { id: true, name: true, domain: true }, orderBy: { createdAt: "asc" } },
    },
  });
  return { access, project, brandName: project.brand?.name ?? project.name, competitors: project.competitors, isDemo: project.organization.isDemo, weights: resolveWeights() };
}

type Ctx = Awaited<ReturnType<typeof projectContext>>;

function loadAnswers(ctx: Ctx, from: Date, to: Date, where: AnswerFilter = {}): Promise<AnswerRow[]> {
  return loadProjectAnswers(ctx.project.id, ctx.isDemo, from, to, where);
}

async function windowAnswers(ctx: Ctx, range: DateRangeKey, where: AnswerFilter = {}) {
  const w = resolveDateWindow(range);
  const [current, previous] = await Promise.all([loadAnswers(ctx, w.from, w.to, where), loadAnswers(ctx, w.previousFrom, w.previousTo, where)]);
  return { window: w, current, previous };
}

const subjects = (ctx: Ctx) => [{ id: null as string | null, name: ctx.brandName, isPrimary: true }, ...ctx.competitors.map((c) => ({ id: c.id as string | null, name: c.name, isPrimary: false }))];

function withDeltas(current: VisibilityMetrics, previous: VisibilityMetrics | null) {
  const d = (a: number | null, b: number | null | undefined, scale = 1) => (a === null || b === null || b === undefined ? null : Math.round((a - b) * scale * 10) / 10);
  return {
    ...current,
    deltas: previous
      ? {
          visibilityScore: scoreDelta(current.visibilityScore, previous.visibilityScore),
          mentionRate: d(current.mentionRate, previous.mentionRate, 100),
          shareOfVoice: d(current.shareOfVoice, previous.shareOfVoice, 100),
          citationRate: d(current.citationRate, previous.citationRate, 100),
          averagePosition: d(current.averagePosition, previous.averagePosition),
        }
      : null,
  };
}

// ── Overview ──────────────────────────────────────────────────

export async function getOverview(userId: string, projectId: string, range: DateRangeKey) {
  const ctx = await projectContext(userId, projectId);
  const { current, previous } = await windowAnswers(ctx, range);
  const [providers, availability, lastScan] = await Promise.all([
    db.aIProvider.findMany({ select: { id: true, slug: true, displayName: true }, orderBy: { createdAt: "asc" } }),
    getProviderAvailability(),
    db.scan.findFirst({ where: { projectId, analysisStatus: "COMPLETED" }, orderBy: { completedAt: "desc" }, select: { completedAt: true } }),
  ]);
  const w = ctx.weights;
  const primary = current.length ? withDeltas(subjectMetrics(current, null, w), previous.length ? subjectMetrics(previous, null, w) : null) : null;
  const byProvider = groupBy(current, (a) => a.providerId);
  const prevByProvider = groupBy(previous, (a) => a.providerId);
  const unavailable = new Map(availability.unavailable.map((u) => [u.slug, UNAVAILABLE_LABELS[u.reason]]));
  const engines = providers.map((p) => {
    const rows = byProvider.get(p.id);
    const prev = prevByProvider.get(p.id);
    return {
      providerId: p.id,
      slug: p.slug,
      name: p.displayName,
      score: rows ? subjectMetrics(rows, null, w).visibilityScore : null,
      delta: rows && prev ? scoreDelta(subjectMetrics(rows, null, w).visibilityScore, subjectMetrics(prev, null, w).visibilityScore) : null,
      answers: rows?.length ?? 0,
      note: rows ? null : (unavailable.get(p.slug) ?? "Not scanned in this period"),
    };
  });
  const competitorTable = subjects(ctx)
    .map((s) => ({ ...s, metrics: subjectMetrics(current, s.id, w) }))
    .sort((a, b) => b.metrics.visibilityScore - a.metrics.visibilityScore);
  const series = dailySeries(current, subjects(ctx).slice(0, 6).map((s) => s.id), w);
  return {
    brandName: ctx.brandName,
    answers: current.length,
    previousAnswers: previous.length,
    primary,
    engines,
    competitorTable,
    series,
    seriesSubjects: subjects(ctx).slice(0, 6),
    lastAnalyzedAt: lastScan?.completedAt ?? null,
    weightsVersion: w.version,
  };
}

// ── Prompts ───────────────────────────────────────────────────

export interface PromptFilters {
  q?: string;
  intent?: PromptIntent;
  providerId?: string;
  status?: PromptStatus;
  country?: string;
  language?: string;
}

export async function getPromptsTable(userId: string, projectId: string, range: DateRangeKey, filters: PromptFilters = {}) {
  const ctx = await projectContext(userId, projectId);
  const { current, previous } = await windowAnswers(ctx, range, filters.providerId ? { providerId: filters.providerId } : {});
  const prompts = await db.prompt.findMany({
    where: {
      projectId,
      isActive: true,
      ...(filters.intent ? { intent: filters.intent } : {}),
      ...(filters.country ? { country: filters.country } : {}),
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.q ? { text: { contains: filters.q, mode: "insensitive" as const } } : {}),
    },
    select: { id: true, text: true, intent: true, priority: true, country: true, language: true, cluster: { select: { name: true } } },
    orderBy: [{ priority: "desc" }, { text: "asc" }],
  });
  const rows = promptRows(prompts.map((p) => p.id), current, previous, ctx.competitors.map((c) => c.id), ctx.weights);
  const byId = new Map(rows.map((r) => [r.promptId, r]));
  const competitorName = new Map(ctx.competitors.map((c) => [c.id, c.name]));
  const table = prompts
    .map((p) => {
      const r = byId.get(p.id)!;
      return { ...p, ...r, trend: scoreDelta(r.visibility, r.previousVisibility), bestCompetitorName: r.bestCompetitor ? competitorName.get(r.bestCompetitor.competitorId)! : null };
    })
    .filter((r) => !filters.status || r.status === filters.status);
  const [providers, markets] = await Promise.all([
    db.aIProvider.findMany({ select: { id: true, displayName: true }, orderBy: { createdAt: "asc" } }),
    db.prompt.findMany({ where: { projectId, isActive: true }, select: { country: true, language: true }, distinct: ["country", "language"] }),
  ]);
  const scannedProviders = providers.filter((p) => current.some((a) => a.providerId === p.id) || p.id === filters.providerId);
  return { rows: table, providers: scannedProviders, allProviders: providers, markets };
}

// ── Prompt detail ─────────────────────────────────────────────

export async function getPromptDetail(userId: string, projectId: string, promptId: string, range: DateRangeKey) {
  const ctx = await projectContext(userId, projectId);
  const prompt = await db.prompt.findFirst({
    where: { id: promptId, projectId },
    select: { id: true, text: true, intent: true, priority: true, country: true, language: true, reason: true, isActive: true, cluster: { select: { name: true } } },
  });
  if (!prompt) throw new AppError("NOT_FOUND", "Prompt not found.");
  const { current, previous } = await windowAnswers(ctx, range, { promptId });
  const w = ctx.weights;
  const latest = latestPerProvider(current);
  const texts = await db.aIResponse.findMany({
    where: { id: { in: latest.map((a) => a.responseId) } },
    select: { id: true, normalizedText: true, model: true, createdAt: true, metadata: true, provider: { select: { displayName: true, slug: true } } },
  });
  const textById = new Map(texts.map((t) => [t.id, t]));
  const competitorName = (id: string) => ctx.competitors.find((c) => c.id === id)?.name ?? "A competitor";
  return {
    prompt,
    brandName: ctx.brandName,
    answers: current.length,
    primary: current.length ? withDeltas(subjectMetrics(current, null, w), previous.length ? subjectMetrics(previous, null, w) : null) : null,
    latest: latest
      .map((a) => ({ ...a, response: textById.get(a.responseId)! }))
      .sort((a, b) => a.response.provider.displayName.localeCompare(b.response.provider.displayName)),
    ranking: subjects(ctx)
      .map((s) => ({ ...s, metrics: subjectMetrics(current, s.id, w) }))
      .filter((s) => s.isPrimary || s.metrics.mentionRate > 0)
      .sort((a, b) => b.metrics.visibilityScore - a.metrics.visibilityScore),
    series: dailySeries(current, [null], w),
    insights: whyLosing(current, { primary: ctx.brandName, competitor: competitorName }),
  };
}

// ── Competitors ───────────────────────────────────────────────

export async function getCompetitorsView(userId: string, projectId: string, range: DateRangeKey) {
  const ctx = await projectContext(userId, projectId);
  const { current, previous } = await windowAnswers(ctx, range);
  const w = ctx.weights;
  const prompts = await db.prompt.findMany({ where: { projectId }, select: { id: true, text: true } });
  const promptText = new Map(prompts.map((p) => [p.id, p.text]));
  return {
    brandName: ctx.brandName,
    answers: current.length,
    series: dailySeries(current, subjects(ctx).slice(0, 6).map((s) => s.id), w),
    rows: subjects(ctx).map((s) => ({
      ...s,
      metrics: subjectMetrics(current, s.id, w),
      delta: previous.length ? scoreDelta(subjectMetrics(current, s.id, w).visibilityScore, subjectMetrics(previous, s.id, w).visibilityScore) : null,
    })),
    wins: ctx.competitors.map((c) => ({
      competitorId: c.id,
      name: c.name,
      prompts: promptsCompetitorWins(current, c.id).map((p) => ({ ...p, text: promptText.get(p.promptId) ?? "" })),
    })),
  };
}

// ── Citations ─────────────────────────────────────────────────

export async function getCitationsView(userId: string, projectId: string, range: DateRangeKey) {
  const ctx = await projectContext(userId, projectId);
  const { current } = await windowAnswers(ctx, range);
  const domains = citationDomains(current);
  const competitorName = new Map(ctx.competitors.map((c) => [c.id, c.name]));
  const total = current.reduce((n, a) => n + a.citations.length, 0);
  return {
    brandName: ctx.brandName,
    answers: current.length,
    answersWithCitations: current.filter((a) => a.citations.length).length,
    totalCitations: total,
    domains: domains.map((d) => ({ ...d, ownerName: d.ownerType === "PRIMARY" ? ctx.brandName : d.competitorId ? (competitorName.get(d.competitorId) ?? null) : null })),
    gaps: domains
      .filter((d) => d.gapScore !== null && d.gapScore > 0)
      .sort((a, b) => b.gapScore! - a.gapScore! || b.answers - a.answers)
      .slice(0, 10),
  };
}
