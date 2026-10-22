/**
 * Domain onboarding: website → brand profile → competitors → prompts.
 *
 * Every entry point authorizes via the central helpers, applies onboarding
 * limits before paid work, and records usage. Collaborators (crawler, LLM)
 * are injected so the flow is testable end-to-end without network access.
 */
import { z } from "zod";
import { db } from "@/server/db";
import { requireOrgAccess, requireProjectAccess } from "@/server/auth/authorization";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { createProject, updateProject } from "@/server/projects/service";
import { crawlSite, type CrawlResult } from "@/server/crawler/crawler";
import { CrawlError } from "@/server/crawler/errors";
import { getOnboardingLLM } from "@/server/ai/config";
import { StructuredOutputError, type StructuredUsage } from "@/server/ai/structured";
import type { StructuredLLMClient } from "@/server/ai/types";
import { Prisma } from "@/generated/prisma/client";
import type { OnboardingStep } from "@/generated/prisma/enums";
import { AppError } from "@/lib/errors";
import { normalizeDomain } from "@/lib/domain";
import { isSupportedCountry, isSupportedLanguage, isValidTimezone } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/monitoring";
import { extractBrandDeterministic, extractBrandWithAI } from "./brand-extraction";
import { suggestCompetitorsWithAI, type BrandContext } from "./competitors";
import { buildInitialPrompts } from "./prompts";
import { assertCanAnalyze, assertCanGenerate, withinAiBudget } from "./limits";
import { recordAiUsage, recordCrawlUsage } from "./usage";
import {
  brandProfileInputSchema,
  competitorsInputSchema,
  MAX_PROMPTS_PER_PROJECT,
  promptReviewSchema,
  type BrandExtraction,
  type BrandProfileInput,
  type PromptReviewInput,
} from "./schemas";

export interface OnboardingDeps {
  llm: StructuredLLMClient | null;
  crawl: (url: string, options: { language?: string }) => Promise<CrawlResult>;
}

export function defaultOnboardingDeps(): OnboardingDeps {
  return { llm: getOnboardingLLM(), crawl: (url, options) => crawlSite(url, undefined, undefined, options) };
}

const log = logger.child({ component: "onboarding" });

const STEP_ORDER: OnboardingStep[] = ["ANALYZE", "BRAND", "COMPETITORS", "PROMPTS", "COMPLETED"];
export const laterStep = (a: OnboardingStep, b: OnboardingStep): OnboardingStep => (STEP_ORDER.indexOf(a) >= STEP_ORDER.indexOf(b) ? a : b);

// ── Step 1: domain submission ─────────────────────────────────

export const startOnboardingSchema = z.object({
  url: z.string().trim().min(1, "Enter your website address").max(2048),
  country: z.string().trim().toUpperCase().refine(isSupportedCountry, "Choose a supported market"),
  language: z.string().trim().toLowerCase().refine(isSupportedLanguage, "Choose a supported language"),
  timezone: z.string().trim().refine(isValidTimezone, "Invalid timezone").default("UTC"),
});
export type StartOnboardingInput = z.input<typeof startOnboardingSchema>;

/** Creates (or resumes) the project for a domain and runs the website analysis. */
export async function startOnboarding(userId: string, organizationId: string, input: StartOnboardingInput, deps: OnboardingDeps = defaultOnboardingDeps()) {
  const access = await requireOrgAccess(userId, { id: organizationId }, "project:create");
  const data = startOnboardingSchema.parse(input);
  const normalized = normalizeDomain(data.url);
  if (!normalized.ok) throw new AppError("VALIDATION", normalized.reason, { field: "url" });

  const existing = await db.project.findFirst({
    where: { organizationId: access.organizationId, domain: normalized.domain },
    select: { id: true, onboardingCompletedAt: true, archivedAt: true },
  });
  if (existing?.onboardingCompletedAt || existing?.archivedAt) {
    throw new AppError("CONFLICT", "A project for this website already exists in this organization.", { projectId: existing.id });
  }

  const projectId = existing
    ? (await updateProject(userId, existing.id, { country: data.country, language: data.language, timezone: data.timezone })).id
    : (await createProject(userId, access.organizationId, { name: normalized.domain, domain: normalized.domain, country: data.country, language: data.language, timezone: data.timezone })).id;

  const analysis = await runWebsiteAnalysis(userId, projectId, deps);
  return { projectId, analysis };
}

// ── Step 2: website analysis + brand extraction ───────────────

function pageSummaries(crawl: CrawlResult) {
  return crawl.pages.map((p) => ({ url: p.url, title: p.title, description: p.description.slice(0, 200), h1: p.headings.h1.slice(0, 2), wordCount: p.wordCount }));
}

export async function runWebsiteAnalysis(userId: string, projectId: string, deps: OnboardingDeps = defaultOnboardingDeps()) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  await assertCanAnalyze(userId, access.organizationId);
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { domain: true, name: true, country: true, language: true, onboardingStep: true } });
  const requestedUrl = `https://${project.domain}/`;
  const analysis = await db.websiteAnalysis.create({ data: { projectId, requestedUrl, createdById: userId }, select: { id: true } });
  const started = Date.now();

  let crawl: CrawlResult;
  try {
    crawl = await deps.crawl(requestedUrl, { language: project.language });
  } catch (error) {
    const known = error instanceof CrawlError;
    if (!known) captureException(error, { component: "onboarding.crawl", projectId });
    log.warn("onboarding.crawl_failed", { projectId, code: known ? error.code : "INTERNAL" });
    await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "onboarding.analysis_failed", entityType: "WebsiteAnalysis", entityId: analysis.id, metadata: { code: known ? error.code : "INTERNAL" } });
    return db.websiteAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "FAILED",
        errorCode: known ? error.code : "INTERNAL",
        errorMessage: known ? error.message : "Something went wrong while analyzing the website.",
        durationMs: Date.now() - started,
        completedAt: new Date(),
      },
    });
  }
  await recordCrawlUsage(access.organizationId, crawl.stats.requests, analysis.id);

  let brand: BrandExtraction;
  let method: "AI" | "DETERMINISTIC" = "DETERMINISTIC";
  let usage: StructuredUsage | undefined;
  let aiError: string | undefined;
  const llm = deps.llm && (await withinAiBudget(access.organizationId)) ? deps.llm : null;
  if (deps.llm && !llm) aiError = "DAILY_AI_BUDGET_REACHED";

  if (llm) {
    try {
      const res = await extractBrandWithAI(llm, crawl, { country: project.country, language: project.language });
      brand = res.brand;
      usage = res.usage;
      method = "AI";
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      usage = error.usage;
      aiError = error.failure;
      brand = extractBrandDeterministic(crawl);
    }
  } else {
    brand = extractBrandDeterministic(crawl);
  }
  const cost = usage ? await recordAiUsage(access.organizationId, usage, analysis.id) : 0;

  await db.$transaction([
    db.brand.upsert({
      where: { projectId },
      create: { projectId, domain: project.domain, name: brand.brandName, description: brand.description, industry: brand.industry || null, products: brand.products, services: brand.services, targetCustomers: brand.targetCustomers, markets: brand.markets, topics: brand.topics },
      update: { name: brand.brandName, description: brand.description, industry: brand.industry || null, products: brand.products, services: brand.services, targetCustomers: brand.targetCustomers, markets: brand.markets, topics: brand.topics },
    }),
    db.project.update({
      where: { id: projectId },
      data: { onboardingStep: laterStep(project.onboardingStep, "BRAND"), ...(project.name === project.domain ? { name: brand.brandName } : {}) },
    }),
  ]);

  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "onboarding.analysis_completed", entityType: "WebsiteAnalysis", entityId: analysis.id, metadata: { method, pages: crawl.pages.length, aiError: aiError ?? null } });
  log.info("onboarding.analysis_completed", { projectId, method, pages: crawl.pages.length, aiError, durationMs: Date.now() - started });

  return db.websiteAnalysis.update({
    where: { id: analysis.id },
    data: {
      status: "COMPLETED",
      method,
      homepageUrl: crawl.homepageUrl,
      site: crawl.site,
      robotsStatus: crawl.robots.homepageOnly ? `${crawl.robots.status}_HOMEPAGE_ONLY` : crawl.robots.status,
      pagesCrawled: crawl.pages.length,
      pages: pageSummaries(crawl),
      failures: crawl.failures.slice(0, 50).map((f) => ({ url: f.url, code: f.code })),
      extraction: { brand, ...(aiError ? { aiError } : {}) },
      aiProvider: usage?.provider ?? null,
      aiModel: usage?.model ?? null,
      aiAttempts: usage?.attempts ?? 0,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      estimatedCost: cost,
      durationMs: Date.now() - started,
      completedAt: new Date(),
    },
  });
}

// ── Step 3: editable brand profile ────────────────────────────

export async function saveBrandProfile(userId: string, projectId: string, input: BrandProfileInput) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const data = brandProfileInputSchema.parse(input);
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { domain: true, onboardingStep: true } });
  const fields = { name: data.brandName, industry: data.industry, description: data.description, products: data.products, services: data.services, targetCustomers: data.targetCustomers, markets: data.markets, topics: data.topics, aliases: data.aliases };
  await db.$transaction([
    db.brand.upsert({ where: { projectId }, create: { projectId, domain: project.domain, ...fields }, update: fields }),
    db.project.update({ where: { id: projectId }, data: { name: data.brandName, onboardingStep: laterStep(project.onboardingStep, "COMPETITORS") } }),
  ]);
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "brand.updated", entityType: "Project", entityId: projectId });
}

async function loadBrandContext(projectId: string): Promise<BrandContext> {
  const brand = await db.brand.findUnique({ where: { projectId } });
  if (!brand || !brand.industry) throw new AppError("VALIDATION", "Complete the brand profile first.");
  const products = Array.isArray(brand.products) ? (brand.products as unknown[]).filter((p): p is string => typeof p === "string") : [];
  return { name: brand.name, domain: brand.domain, industry: brand.industry, description: brand.description ?? "", products, targetCustomers: brand.targetCustomers, aliases: brand.aliases };
}

// ── Step 4: competitors ───────────────────────────────────────

export type CompetitorSuggestionMethod = "AI" | "EXISTING" | "UNAVAILABLE";

/**
 * Suggests ~5 competitors with AI. Without a configured AI provider this
 * returns UNAVAILABLE and the user adds competitors manually — competitors
 * are never guessed without a model.
 */
export async function suggestCompetitors(userId: string, projectId: string, deps: OnboardingDeps = defaultOnboardingDeps(), options: { replace?: boolean } = {}) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const brand = await loadBrandContext(projectId);
  const existing = await db.competitor.count({ where: { projectId, isActive: true } });
  if (existing > 0 && !options.replace) return { method: "EXISTING" as CompetitorSuggestionMethod, added: 0 };

  const llm = deps.llm && (await withinAiBudget(access.organizationId)) ? deps.llm : null;
  if (!llm) return { method: "UNAVAILABLE" as CompetitorSuggestionMethod, added: 0 };
  await assertCanGenerate(userId);

  if (options.replace) {
    await db.competitor.deleteMany({ where: { projectId, source: "AI_SUGGESTED", mentions: { none: {} } } });
  }
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { country: true, language: true } });
  try {
    const { competitors, usage } = await suggestCompetitorsWithAI(llm, brand, project);
    await recordAiUsage(access.organizationId, usage, projectId);
    const result = await db.competitor.createMany({
      data: competitors.map((c) => ({ projectId, name: c.name, domain: c.domain, reason: c.reason, confidence: c.confidence, source: "AI_SUGGESTED" as const })),
      skipDuplicates: true,
    });
    await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "onboarding.competitors_suggested", entityType: "Project", entityId: projectId, metadata: { count: result.count } });
    return { method: "AI" as CompetitorSuggestionMethod, added: result.count };
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error;
    await recordAiUsage(access.organizationId, error.usage, projectId);
    log.warn("onboarding.competitors_ai_failed", { projectId, failure: error.failure });
    return { method: "UNAVAILABLE" as CompetitorSuggestionMethod, added: 0 };
  }
}

/** Replaces the active competitor set with the user's edited list. */
export async function saveCompetitors(userId: string, projectId: string, input: unknown) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const items = competitorsInputSchema.parse(input);
  const normalized = items.map((c, index) => {
    if (!c.domain) return { ...c, domain: null as string | null };
    const d = normalizeDomain(c.domain);
    if (!d.ok) throw new AppError("VALIDATION", `${c.name}: ${d.reason}`, { index, field: "domain" });
    return { ...c, domain: d.domain };
  });
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { domain: true, onboardingStep: true } });
  if (normalized.some((c) => c.domain === project.domain)) throw new AppError("VALIDATION", "Your own domain can't be a competitor.");

  try {
    await saveCompetitorSet(projectId, project.onboardingStep, normalized);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError("CONFLICT", "Competitor names must be unique.");
    throw error;
  }
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "competitors.updated", entityType: "Project", entityId: projectId, metadata: { count: normalized.length } });
}

async function saveCompetitorSet(projectId: string, step: OnboardingStep, normalized: Array<{ id?: string; name: string; domain: string | null }>) {
  await db.$transaction(async (tx) => {
    const current = await tx.competitor.findMany({ where: { projectId }, select: { id: true, name: true, _count: { select: { mentions: true } } } });
    const byId = new Map(current.map((c) => [c.id, c]));
    const byName = new Map(current.map((c) => [c.name.toLowerCase(), c]));
    const keep = new Set<string>();

    for (const c of normalized) {
      // Ids from the client are only honoured if they belong to this project.
      const match = (c.id && byId.get(c.id)) || byName.get(c.name.toLowerCase());
      if (match) {
        keep.add(match.id);
        await tx.competitor.update({ where: { id: match.id }, data: { name: c.name, domain: c.domain, isActive: true } });
      } else {
        const created = await tx.competitor.create({ data: { projectId, name: c.name, domain: c.domain, source: "USER" } });
        keep.add(created.id);
      }
    }
    const removed = current.filter((c) => !keep.has(c.id));
    // Competitors with recorded mentions are deactivated to preserve history; others are deleted.
    await tx.competitor.updateMany({ where: { id: { in: removed.filter((c) => c._count.mentions > 0).map((c) => c.id) } }, data: { isActive: false } });
    await tx.competitor.deleteMany({ where: { id: { in: removed.filter((c) => c._count.mentions === 0).map((c) => c.id) } } });
    await tx.project.update({ where: { id: projectId }, data: { onboardingStep: laterStep(step, "PROMPTS") } });
  });
}

// ── Step 5: prompt generation + review ────────────────────────

export async function generatePrompts(userId: string, projectId: string, deps: OnboardingDeps = defaultOnboardingDeps(), options: { replace?: boolean } = {}) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const brand = await loadBrandContext(projectId);
  const pending = await db.prompt.count({ where: { projectId, approvedAt: null } });
  if (pending > 0 && !options.replace) return { method: "EXISTING" as const, created: 0 };
  await assertCanGenerate(userId);

  const [project, competitors, brandRow] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId }, select: { country: true, language: true } }),
    db.competitor.findMany({ where: { projectId, isActive: true }, select: { name: true }, orderBy: [{ confidence: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }] }),
    db.brand.findUniqueOrThrow({ where: { projectId }, select: { topics: true } }),
  ]);
  const llm = deps.llm && (await withinAiBudget(access.organizationId)) ? deps.llm : null;
  const result = await buildInitialPrompts(llm, { brand, competitors, topics: brandRow.topics, market: project });
  for (const u of result.usage) await recordAiUsage(access.organizationId, u, projectId);

  const created = await db.$transaction(async (tx) => {
    if (options.replace) await tx.prompt.deleteMany({ where: { projectId, approvedAt: null, scanJobs: { none: {} } } });
    const clusterIds = await upsertClusters(tx, projectId, result.prompts.map((p) => p.cluster));
    const res = await tx.prompt.createMany({
      data: result.prompts.map((p) => ({
        projectId,
        text: p.text,
        intent: p.intent,
        clusterId: clusterIds.get(p.cluster.toLowerCase()) ?? null,
        country: p.country,
        language: p.language,
        priority: p.priority,
        reason: p.reason,
        source: p.source,
        isActive: false,
      })),
      skipDuplicates: true,
    });
    return res.count;
  });
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: "onboarding.prompts_generated", entityType: "Project", entityId: projectId, metadata: { method: result.method, created, aiError: result.aiError ?? null } });
  return { method: result.method, created, aiError: result.aiError };
}

async function upsertClusters(tx: Prisma.TransactionClient, projectId: string, names: string[]): Promise<Map<string, string>> {
  const unique = [...new Map(names.filter(Boolean).map((n) => [n.toLowerCase(), n.trim().slice(0, 60)])).values()];
  const existing = await tx.promptCluster.findMany({ where: { projectId }, select: { id: true, name: true } });
  const map = new Map(existing.map((c) => [c.name.toLowerCase(), c.id]));
  for (const name of unique) {
    if (map.has(name.toLowerCase())) continue;
    const created = await tx.promptCluster.create({ data: { projectId, name }, select: { id: true } });
    map.set(name.toLowerCase(), created.id);
  }
  return map;
}

/** Applies the user's review: edits, additions, deletions and approvals. `finish` completes onboarding. */
export async function savePromptReview(userId: string, projectId: string, input: PromptReviewInput) {
  const access = await requireProjectAccess(userId, projectId, "project:update");
  const data = promptReviewSchema.parse(input);
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId }, select: { country: true, language: true } });

  const texts = data.prompts.map((p) => p.text.toLowerCase());
  if (new Set(texts).size !== texts.length) throw new AppError("VALIDATION", "Each prompt must be unique.");
  if (data.finish && !data.prompts.some((p) => p.approved)) throw new AppError("VALIDATION", "Approve at least one prompt to continue.");

  try {
    await db.$transaction(async (tx) => {
      const owned = await tx.prompt.findMany({ where: { projectId }, select: { id: true, approvedAt: true, _count: { select: { scanJobs: true } } } });
      const ownedById = new Map(owned.map((p) => [p.id, p]));
      const foreign = [...data.prompts.map((p) => p.id).filter(Boolean), ...data.deletedIds].filter((id) => !ownedById.has(id!));
      if (foreign.length) throw new AppError("NOT_FOUND", "Some prompts were not found in this project.");

      const deleted = data.deletedIds.map((id) => ownedById.get(id)!);
      await tx.prompt.deleteMany({ where: { id: { in: deleted.filter((p) => p._count.scanJobs === 0).map((p) => p.id) } } });
      // Prompts with scan history are deactivated, never deleted.
      await tx.prompt.updateMany({ where: { id: { in: deleted.filter((p) => p._count.scanJobs > 0).map((p) => p.id) } }, data: { isActive: false } });

      const remaining = owned.length - deleted.length + data.prompts.filter((p) => !p.id).length;
      if (remaining > MAX_PROMPTS_PER_PROJECT) throw new AppError("LIMIT_EXCEEDED", `A project can track up to ${MAX_PROMPTS_PER_PROJECT} prompts.`);

      const clusterIds = await upsertClusters(tx, projectId, data.prompts.map((p) => p.cluster));
      const now = new Date();
      for (const p of data.prompts) {
        const fields = {
          text: p.text,
          intent: p.intent,
          priority: p.priority,
          clusterId: clusterIds.get(p.cluster.toLowerCase()) ?? null,
          isActive: p.approved,
          approvedAt: p.approved ? ((p.id && ownedById.get(p.id)?.approvedAt) || now) : null,
          reviewedAt: now,
        };
        if (p.id) await tx.prompt.update({ where: { id: p.id }, data: fields });
        else await tx.prompt.create({ data: { ...fields, projectId, country: project.country, language: project.language, source: "USER" } });
      }
      if (data.finish) await tx.project.update({ where: { id: projectId }, data: { onboardingStep: "COMPLETED", onboardingCompletedAt: now } });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("CONFLICT", "A prompt with the same text already exists in this project.");
    }
    throw error;
  }
  const approved = data.prompts.filter((p) => p.approved).length;
  await writeAuditLog({ organizationId: access.organizationId, actorId: userId, action: data.finish ? "onboarding.completed" : "prompts.reviewed", entityType: "Project", entityId: projectId, metadata: { approved, deleted: data.deletedIds.length } });
  return { approved };
}

// ── Read model ────────────────────────────────────────────────

export async function getOnboardingState(userId: string, projectId: string) {
  const access = await requireProjectAccess(userId, projectId, "project:read");
  const [project, brand, analysis, competitors, prompts] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true, name: true, domain: true, country: true, language: true, onboardingStep: true, onboardingCompletedAt: true } }),
    db.brand.findUnique({ where: { projectId } }),
    db.websiteAnalysis.findFirst({ where: { projectId }, orderBy: { createdAt: "desc" } }),
    db.competitor.findMany({ where: { projectId, isActive: true }, orderBy: [{ confidence: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }] }),
    db.prompt.findMany({ where: { projectId }, include: { cluster: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }] }),
  ]);
  return { access, project, brand, analysis, competitors, prompts };
}

export function nextOnboardingPath(step: OnboardingStep): "brand" | "competitors" | "prompts" | null {
  if (step === "ANALYZE" || step === "BRAND") return "brand";
  if (step === "COMPETITORS") return "competitors";
  if (step === "PROMPTS") return "prompts";
  return null;
}
