/**
 * Free public audit (/audit): a small, capped, anonymous version of the
 * product — crawl the homepage, identify the brand and its competitors, ask
 * one AI engine 5 buyer prompts, and score visibility. Details are locked
 * behind sign-up; the teaser shows counts only.
 *
 * Abuse and cost protection:
 * - feature flag + global scan kill switch;
 * - honeypot field and an HMAC-signed form token (min fill time, max age);
 * - per-IP limits (hourly, daily; counted in the DB, IPs stored only as salted hashes), a global daily cap, and a 24 h per-domain
 *   cache (repeat requests reuse the result: no new provider calls);
 * - SSRF-safe crawler with small limits; 5 queries on 1 engine, no retries.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/server/db";
import { isFeatureEnabled } from "@/server/flags/flags";
import { getScanKillSwitch } from "@/server/system/settings";
import { getProviderAvailability, type ReadyProvider } from "@/server/providers/registry";
import { enqueuePublicAudit } from "@/server/queue/queues";
import { crawlSite, type CrawlResult } from "@/server/crawler/crawler";
import { crawlLimitsFromEnv } from "@/server/crawler/config";
import { extractBrandDeterministic, extractBrandWithAI } from "@/server/onboarding/brand-extraction";
import { suggestCompetitorsWithAI } from "@/server/onboarding/competitors";
import { templatePrompts } from "@/server/onboarding/prompts";
import { analyzeResponse } from "@/server/analysis/analyze";
import { getOnboardingLLM } from "@/server/ai/config";
import type { StructuredLLMClient } from "@/server/ai/types";
import { subjectMetrics, type AnswerRow } from "@/server/dashboard/aggregate";
import { resolveWeights } from "@/server/scoring/visibility";
import { recommend } from "@/server/opportunities/recommend";
import type { OpportunityDraft } from "@/server/opportunities/rules";
import type { PromptIntent } from "@/generated/prisma/enums";
import { normalizeDomain } from "@/lib/domain";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

const log = logger.child({ module: "public-audit" });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const AUDIT_LIMITS = {
  prompts: 5,
  perIpHour: 3,
  perIpDay: 10,
  domainCacheMs: DAY,
  minFillMs: 2_000,
  maxFormAgeMs: 2 * HOUR,
  crawlPages: 3,
} as const;

export const auditDailyCap = (env: NodeJS.ProcessEnv = process.env) => {
  const n = Number(env.PUBLIC_AUDIT_DAILY_CAP);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
};

// ── Anti-bot form token ───────────────────────────────────────

const secret = () => process.env.AUTH_SECRET ?? "";
const sign = (v: string) => createHmac("sha256", secret()).update(`audit-form:${v}`).digest("base64url");

/** Issued with the form; proves the request came from our page and wasn't instant. */
export function issueFormToken(now = Date.now()) {
  return `${now}.${sign(String(now))}`;
}

export function checkFormToken(token: string | undefined, now = Date.now()): "ok" | "invalid" | "too_fast" | "expired" {
  const [ts, mac] = (token ?? "").split(".");
  if (!ts || !mac || !/^\d+$/.test(ts)) return "invalid";
  const expected = Buffer.from(sign(ts));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  const age = now - Number(ts);
  if (age < AUDIT_LIMITS.minFillMs) return "too_fast";
  if (age > AUDIT_LIMITS.maxFormAgeMs) return "expired";
  return "ok";
}

export const ipHash = (ip: string) => createHash("sha256").update(`${secret()}:${ip}`).digest("hex");

// ── Request ───────────────────────────────────────────────────

export const auditRequestSchema = z.object({
  domain: z.string().trim().min(1, "Enter your website").max(2048),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default("US"),
  formToken: z.string().optional(),
  /** Honeypot: humans never fill it. */
  website: z.string().optional(),
});

export interface AuditDeps {
  enqueue: (auditId: string) => Promise<void>;
  availability: () => Promise<{ ready: ReadyProvider[] }>;
}
export const defaultAuditDeps = (): AuditDeps => ({ enqueue: enqueuePublicAudit, availability: () => getProviderAvailability() });

export async function requestAudit(raw: unknown, ip: string, deps: AuditDeps = defaultAuditDeps(), now = new Date()): Promise<{ auditId: string; cached: boolean }> {
  if (!(await isFeatureEnabled("publicAudit"))) throw new AppError("FEATURE_DISABLED", "The free audit isn't available right now.");
  const input = auditRequestSchema.parse(raw);
  // Bots: the honeypot or a bad/instant token get a generic answer and cost nothing.
  if (input.website || checkFormToken(input.formToken, now.getTime()) !== "ok") throw new AppError("VALIDATION", "Please reload the page and try again.");
  const normalized = normalizeDomain(input.domain);
  if (!normalized.ok) throw new AppError("VALIDATION", normalized.reason);
  const domain = normalized.domain;
  const hashed = ipHash(ip);

  // Same domain recently: reuse the result (or the run in progress) — no new provider calls.
  const recent = await db.publicAudit.findFirst({
    where: { domain, createdAt: { gte: new Date(now.getTime() - AUDIT_LIMITS.domainCacheMs) }, status: { in: ["PENDING", "RUNNING", "COMPLETED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (recent) return { auditId: recent.id, cached: true };

  if ((await getScanKillSwitch()).enabled) throw new AppError("UNAVAILABLE", "Audits are paused for a moment. Please try again later.");
  // Counted from the database so limits hold across app instances and restarts.
  const ran = (sinceMs: number) => db.publicAudit.count({ where: { ipHash: hashed, createdAt: { gte: new Date(now.getTime() - sinceMs) }, status: { not: "RATE_LIMITED" } } });
  const [hour, day] = await Promise.all([ran(HOUR), ran(DAY)]);
  // Cheap in-process burst guard in front of the queries above.
  const burst = await rateLimit(`audit:ip:burst:${hashed}`, 10, 60_000);
  if (hour >= AUDIT_LIMITS.perIpHour || day >= AUDIT_LIMITS.perIpDay || !burst.allowed) {
    await db.publicAudit.create({ data: { domain, ipHash: hashed, status: "RATE_LIMITED" } });
    throw new AppError("LIMIT_EXCEEDED", "You've run several audits recently. Create a free account to keep going.");
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ranToday = await db.publicAudit.count({ where: { createdAt: { gte: today }, status: { in: ["PENDING", "RUNNING", "COMPLETED", "FAILED"] } } });
  if (ranToday >= auditDailyCap()) throw new AppError("UNAVAILABLE", "Today's free audits are used up. Create a free account to run a full analysis.");
  if (!(await deps.availability()).ready.length) throw new AppError("UNAVAILABLE", "The audit can't run right now: no AI engine is available.");

  const audit = await db.publicAudit.create({ data: { domain, ipHash: hashed, status: "PENDING", result: { country: input.country } } });
  try {
    await deps.enqueue(audit.id);
  } catch (error) {
    await db.publicAudit.update({ where: { id: audit.id }, data: { status: "FAILED", result: { country: input.country, error: "Queue unavailable" } } });
    log.error("audit.enqueue_failed", { auditId: audit.id, error });
    throw new AppError("UNAVAILABLE", "The audit couldn't start. Please try again shortly.");
  }
  log.info("audit.requested", { auditId: audit.id, domain });
  return { auditId: audit.id, cached: false };
}

// ── Run (worker) ──────────────────────────────────────────────

export interface AuditResult {
  version: 1;
  country: string;
  brand: { name: string; industry: string | null };
  engine: { slug: string; name: string; model: string; localized: boolean };
  prompts: Array<{ text: string; intent: PromptIntent; mentioned: boolean; position: number | null }>;
  score: number;
  mentionRate: number;
  competitors: Array<{ name: string; score: number; mentionRate: number }>;
  teaser: { lostPrompts: number; citationOpportunities: number; recommendedActions: number };
  /** Kept for the signed-up account; never sent to the anonymous page. */
  locked: { lostPrompts: string[]; citationDomains: string[] };
  /** AI engine query cost; onboarding-model usage is recorded as tokens. */
  costUsd: number;
  llmTokens: number;
  durationMs: number;
}

export interface AuditRunDeps {
  llm: StructuredLLMClient | null;
  availability: () => Promise<{ ready: ReadyProvider[] }>;
  crawl: typeof crawlSite;
}
export const defaultAuditRunDeps = (): AuditRunDeps => ({ llm: getOnboardingLLM(), availability: () => getProviderAvailability(), crawl: crawlSite });

const ENGINE_PREFERENCE = ["openai", "perplexity", "gemini"];

export async function runAudit(auditId: string, deps: AuditRunDeps = defaultAuditRunDeps()): Promise<void> {
  const claimed = await db.publicAudit.updateMany({ where: { id: auditId, status: "PENDING" }, data: { status: "RUNNING" } });
  if (!claimed.count) return; // already ran (or was never queued properly)
  const audit = await db.publicAudit.findUniqueOrThrow({ where: { id: auditId } });
  const country = ((audit.result as { country?: string } | null)?.country ?? "US").toUpperCase();
  const started = Date.now();
  const fail = async (message: string) => {
    await db.publicAudit.update({ where: { id: auditId }, data: { status: "FAILED", result: { country, error: message } } });
    log.warn("audit.failed", { auditId, message });
  };
  try {
    if ((await getScanKillSwitch()).enabled) return fail("Audits are paused at the moment.");
    const { ready } = await deps.availability();
    const engine = [...ready].sort((a, b) => ENGINE_PREFERENCE.indexOf(a.slug) - ENGINE_PREFERENCE.indexOf(b.slug))[0];
    if (!engine) return fail("No AI engine is available.");

    const crawl = await deps.crawl(`https://${audit.domain}/`, { ...crawlLimitsFromEnv(), maxPages: AUDIT_LIMITS.crawlPages, totalBudgetMs: 20_000 });
    if (!crawl.pages.length) return fail("We couldn't read this website (it may block crawlers or be offline).");
    const market = { country, language: "en" };
    let cost = 0;
    let llmTokens = 0;
    let brand = extractBrandDeterministic(crawl);
    if (deps.llm) {
      const ai = await extractBrandWithAI(deps.llm, crawl, market).catch(() => null);
      if (ai) {
        brand = ai.brand;
        llmTokens += ai.usage.inputTokens + ai.usage.outputTokens;
      }
    }
    if (!brand.industry) brand = { ...brand, industry: guessCategory(crawl, brand.brandName) };
    const brandCtx = { name: brand.brandName, domain: audit.domain, industry: brand.industry, description: brand.description, products: brand.products, targetCustomers: brand.targetCustomers, aliases: [] as string[] };
    let competitors: Array<{ name: string; domain: string | null }> = [];
    if (deps.llm) {
      const suggested = await suggestCompetitorsWithAI(deps.llm, brandCtx, market, 4).catch(() => null);
      if (suggested) {
        competitors = suggested.competitors;
        llmTokens += suggested.usage.inputTokens + suggested.usage.outputTokens;
      }
    }
    const prompts = pickPrompts(templatePrompts({ brand: brandCtx, competitors, topics: brand.topics, market }));
    if (!prompts.length) return fail("We couldn't work out what this website sells.");

    const compIds = competitors.map((c, i) => ({ id: `c${i}`, name: c.name, aliases: [], domain: c.domain }));
    const ctx = { primary: { name: brand.brandName, aliases: [], domain: audit.domain }, competitors: compIds };
    const answers: AnswerRow[] = [];
    const promptResults: AuditResult["prompts"] = [];
    for (const p of prompts) {
      const res = await engine.adapter.query({ prompt: p.text, country, language: "en", projectId: "public-audit", promptId: auditId }).catch((e) => {
        log.warn("audit.query_failed", { auditId, error: String(e?.message ?? e) });
        return null;
      });
      if (!res) continue;
      cost += res.estimatedCost;
      const a = analyzeResponse({ normalizedText: res.normalizedText, rawText: res.rawText, language: "en", providerCitations: res.citations }, ctx);
      answers.push({
        responseId: `${auditId}:${answers.length}`,
        promptId: p.text,
        providerId: engine.slug,
        createdAt: new Date(),
        country,
        language: "en",
        brandsMentionedCount: a.brandsMentionedCount,
        mentions: a.mentions.map((m) => ({ isPrimaryBrand: m.key === "primary", competitorId: m.competitorId, brandName: m.name, position: m.position, sentiment: m.sentiment, snippet: null })),
        citations: a.citations.map((c) => ({ ownerType: c.ownerType, competitorId: c.competitorId ?? null, domain: c.domain, url: c.url, title: c.title ?? null, position: c.position })),
      });
      promptResults.push({ text: p.text, intent: p.intent, mentioned: a.primaryBrand.mentioned, position: a.primaryBrand.position });
    }
    if (!answers.length) return fail("The AI engine didn't answer. Please try again later.");

    const w = resolveWeights();
    const mine = subjectMetrics(answers, null, w);
    // Lost: a buyer question whose answer doesn't mention the brand at all.
    const lost = answers.filter((a) => !a.mentions.some((m) => m.isPrimaryBrand));
    const lostTexts = lost.map((a) => a.promptId);
    const citationDomains = [...new Set(lost.flatMap((a) => a.citations.filter((c) => c.ownerType === "THIRD_PARTY").map((c) => c.domain)))];
    // The same templates the product uses: what the account would recommend for these findings.
    const recCount =
      lostTexts.reduce((n, text) => n + recommend(lostDraft(text, prompts.find((p) => p.text === text)!.intent), { brand: { name: brand.brandName, domain: audit.domain, industry: brand.industry }, competitors: compIds.map((c) => ({ id: c.id, name: c.name, domain: c.domain })), prompt: { id: text, text, intent: prompts.find((p) => p.text === text)!.intent, priority: 4 } }).length, 0) + citationDomains.length;

    const result: AuditResult = {
      version: 1,
      country,
      brand: { name: brand.brandName, industry: brand.industry || null },
      engine: { slug: engine.slug, name: engine.displayName, model: engine.modelId, localized: engine.adapter.capabilities.location },
      prompts: promptResults,
      score: mine.visibilityScore,
      mentionRate: mine.mentionRate,
      competitors: compIds.map((c) => {
        const m = subjectMetrics(answers, c.id, w);
        return { name: c.name, score: m.visibilityScore, mentionRate: m.mentionRate };
      }).sort((a, b) => b.score - a.score),
      teaser: { lostPrompts: lostTexts.length, citationOpportunities: citationDomains.length, recommendedActions: recCount },
      locked: { lostPrompts: lostTexts, citationDomains },
      costUsd: Math.round(cost * 1e6) / 1e6,
      llmTokens,
      durationMs: Date.now() - started,
    };
    await db.publicAudit.update({ where: { id: auditId }, data: { status: "COMPLETED", result: result as object } });
    log.info("audit.completed", { auditId, domain: audit.domain, score: result.score, cost: result.costUsd });
  } catch (error) {
    log.error("audit.crashed", { auditId, error });
    await fail("Something went wrong while auditing this website.");
  }
}

/**
 * Without an AI model, use the homepage's own short headline as the category
 * ("CRM software for small teams"). Long marketing sentences are rejected:
 * a wrong category would produce misleading prompts, so we fail instead.
 */
export function guessCategory(crawl: CrawlResult, brandName: string): string {
  const home = crawl.pages[0];
  if (!home) return "";
  const brandRe = new RegExp(brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const candidates = [...home.headings.h1, ...home.title.split(/\s[|—–-]\s/)].map((t) => t.replace(brandRe, "").replace(/^[\s:|—–-]+|[\s:|—–.!-]+$/g, "").trim());
  return candidates.find((c) => /^[\p{L}\p{N}][\p{L}\p{N}\s&'-]{2,60}$/u.test(c) && c.split(/\s+/).length <= 6) ?? "";
}

function pickPrompts(templates: ReturnType<typeof templatePrompts>) {
  // Commercial intent first: these are the prompts buyers ask before choosing.
  const order: PromptIntent[] = ["COMMERCIAL", "COMPARISON", "ALTERNATIVE", "TRANSACTIONAL", "INFORMATIONAL", "BRANDED"];
  const seen = new Set<string>();
  return [...templates]
    .sort((a, b) => order.indexOf(a.intent) - order.indexOf(b.intent) || b.priority - a.priority)
    .filter((t) => (seen.has(t.text.toLowerCase()) ? false : (seen.add(t.text.toLowerCase()), true)))
    .slice(0, AUDIT_LIMITS.prompts);
}

function lostDraft(text: string, intent: PromptIntent): OpportunityDraft {
  return { type: "LOST_PROMPT", fingerprint: `audit:${text}`, promptId: text, title: text, description: "", evidence: { answers: 1, yourMentions: 0, intent }, impactScore: 70, confidenceScore: 0.3 };
}

// ── Public read model ─────────────────────────────────────────

/** What the anonymous audit page may show: no locked details. */
export async function getPublicAudit(auditId: string) {
  if (!/^[a-z0-9]{20,32}$/.test(auditId)) return null;
  const a = await db.publicAudit.findUnique({ where: { id: auditId }, select: { id: true, domain: true, status: true, result: true, createdAt: true } });
  if (!a || a.status === "RATE_LIMITED") return null;
  const r = a.result as (Partial<AuditResult> & { error?: string }) | null;
  if (a.status !== "COMPLETED" || !r?.teaser) return { id: a.id, domain: a.domain, status: a.status, error: r?.error ?? null, createdAt: a.createdAt, result: null };
  const { locked: _locked, costUsd: _cost, ...visible } = r as AuditResult;
  return { id: a.id, domain: a.domain, status: a.status, error: null, createdAt: a.createdAt, result: visible };
}

/** Sign-up from an audit: remember the conversion (acquisition tracking). */
export async function markAuditConverted(auditId: string, userId: string) {
  if (!/^[a-z0-9]{20,32}$/.test(auditId)) return null;
  const a = await db.publicAudit.findUnique({ where: { id: auditId }, select: { domain: true, convertedTo: true } });
  if (!a) return null;
  if (!a.convertedTo) await db.publicAudit.update({ where: { id: auditId }, data: { convertedTo: `user:${userId}` } });
  return a.domain;
}
