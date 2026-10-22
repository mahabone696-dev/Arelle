/**
 * Initial prompt set generation: AI first, validated and balanced
 * deterministically, with a labelled template fallback for any shortfall.
 */
import type { PromptIntent } from "@/generated/prisma/enums";
import { generateStructured, StructuredOutputError, type StructuredUsage } from "@/server/ai/structured";
import type { StructuredLLMClient } from "@/server/ai/types";
import { countryName, languageName } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import type { Market } from "./brand-extraction";
import type { BrandContext } from "./competitors";
import { PROMPT_DISTRIBUTION, PROMPT_INTENTS } from "./intents";
import { generatedPromptsSchema, type GeneratedPrompt } from "./schemas";

export interface PromptContext {
  brand: BrandContext;
  competitors: Array<{ name: string }>;
  topics: string[];
  market: Market;
}

export type PromptSource = "AI_SUGGESTED" | "TEMPLATE";

export interface FinalPrompt {
  text: string;
  intent: PromptIntent;
  cluster: string;
  priority: number;
  country: string;
  language: string;
  reason: string;
  source: PromptSource;
}

export type Quotas = Record<PromptIntent, number>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive brand mention check (Unicode-aware). */
export function mentionsAny(text: string, names: string[]): boolean {
  return names
    .map((n) => n.trim())
    .filter((n) => n.length >= 2)
    .some((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

export const promptKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function cleanPromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
}

export interface FinalizeResult {
  accepted: FinalPrompt[];
  missing: Quotas;
  rejected: Array<{ text: string; reason: string }>;
  adjustments: { marketOverridden: number; reclassifiedAsBranded: number };
}

/**
 * Validates semantics the schema can't: market codes, brand mentions,
 * duplicates, and per-intent quotas. Highest-priority prompts win a quota.
 */
export function finalizePrompts(raw: GeneratedPrompt[], ctx: PromptContext, quotas: Quotas, existing: FinalPrompt[] = [], source: PromptSource = "AI_SUGGESTED"): FinalizeResult {
  const brandNames = [ctx.brand.name, ...ctx.brand.aliases];
  const seen = new Set(existing.map((p) => promptKey(p.text)));
  const counts = Object.fromEntries(PROMPT_INTENTS.map((i) => [i, existing.filter((p) => p.intent === i).length])) as Quotas;
  const rejected: FinalizeResult["rejected"] = [];
  const adjustments = { marketOverridden: 0, reclassifiedAsBranded: 0 };
  const accepted: FinalPrompt[] = [];

  const candidates = [...raw].sort((a, b) => b.priority - a.priority);
  for (const p of candidates) {
    const text = cleanPromptText(p.text);
    const key = promptKey(text);
    if (text.length < 3 || !key) {
      rejected.push({ text, reason: "empty" });
      continue;
    }
    if (seen.has(key)) {
      rejected.push({ text, reason: "duplicate" });
      continue;
    }
    let intent = p.intent;
    const namesBrand = mentionsAny(text, brandNames);
    if (intent === "BRANDED" && !namesBrand) {
      rejected.push({ text, reason: "branded prompt does not mention the brand" });
      continue;
    }
    // Prompts naming the brand measure branded demand, not discovery — except brand-vs-competitor comparisons.
    if (namesBrand && intent !== "BRANDED" && intent !== "COMPARISON") {
      intent = "BRANDED";
      adjustments.reclassifiedAsBranded++;
    }
    if (counts[intent] >= quotas[intent]) {
      rejected.push({ text, reason: `quota for ${intent} reached` });
      continue;
    }
    if (p.country.toUpperCase() !== ctx.market.country || p.language.toLowerCase() !== ctx.market.language) adjustments.marketOverridden++;
    seen.add(key);
    counts[intent]++;
    accepted.push({
      text,
      intent,
      cluster: p.cluster.trim().slice(0, 60) || "General",
      priority: Math.min(5, Math.max(1, Math.round(p.priority))),
      country: ctx.market.country,
      language: ctx.market.language,
      reason: p.reason.trim(),
      source,
    });
  }
  const missing = Object.fromEntries(PROMPT_INTENTS.map((i) => [i, Math.max(0, quotas[i] - counts[i])])) as Quotas;
  return { accepted, missing, rejected, adjustments };
}

const sumQuotas = (q: Quotas) => Object.values(q).reduce((a, b) => a + b, 0);

function promptSystem(ctx: PromptContext, quotas: Quotas): string {
  const counts = PROMPT_INTENTS.filter((i) => quotas[i] > 0).map((i) => `${i}: ${quotas[i]}`).join(", ");
  return [
    "You write the questions real buyers type into AI assistants (ChatGPT, Gemini, Perplexity) when researching a purchase in a given category.",
    `Generate exactly these counts per intent — ${counts}.`,
    "Intent definitions:",
    "- INFORMATIONAL: problem or how-to questions in the category, no brand names.",
    "- COMMERCIAL: shortlist questions like \"best X for Y\", no brand names.",
    "- TRANSACTIONAL: pricing, cost, free plan, buying or sign-up intent, no brand names.",
    "- COMPARISON: \"A vs B\" between named products; include the brand against a competitor or two competitors.",
    "- ALTERNATIVE: \"alternatives to <competitor>\". Never ask for alternatives to the brand itself.",
    "- BRANDED: questions that name the brand (reviews, pricing, use cases).",
    "Rules: natural phrasing, 3–15 words, no numbering, no quotes, every prompt distinct. Only BRANDED and COMPARISON prompts may name the brand.",
    `Write every prompt in ${languageName(ctx.market.language)} as asked by someone in ${countryName(ctx.market.country)}. Set country to "${ctx.market.country}" and language to "${ctx.market.language}".`,
    "cluster: a short topic group (2–4 words); reuse the same cluster names across related prompts, 4–8 clusters in total.",
    "priority: 1–5 by commercial value to the brand (5 = buyer close to a decision). reason: one sentence on why this prompt matters for the brand.",
  ].join("\n");
}

function promptUser(ctx: PromptContext, avoid: string[]): string {
  return JSON.stringify({
    brand: ctx.brand.name,
    domain: ctx.brand.domain,
    category: ctx.brand.industry,
    description: ctx.brand.description,
    products: ctx.brand.products,
    targetCustomers: ctx.brand.targetCustomers,
    topics: ctx.topics,
    competitors: ctx.competitors.map((c) => c.name),
    ...(avoid.length ? { alreadyHave: avoid } : {}),
  });
}

export async function generatePromptsWithAI(llm: StructuredLLMClient, ctx: PromptContext, quotas: Quotas, avoid: string[] = []): Promise<{ prompts: GeneratedPrompt[]; usage: StructuredUsage }> {
  const { data, usage } = await generateStructured(llm, {
    schema: generatedPromptsSchema,
    schemaName: "prompt_set",
    maxOutputTokens: 6000,
    system: promptSystem(ctx, quotas),
    user: promptUser(ctx, avoid),
  });
  return { prompts: data.prompts, usage };
}

// ── Deterministic templates (English) ─────────────────────────

type Template = Omit<FinalPrompt, "country" | "language" | "source">;

export function templatePrompts(ctx: PromptContext): Template[] {
  const brand = ctx.brand.name;
  const category = ctx.brand.industry.trim() || ctx.topics[0] || "";
  if (!category) return [];
  const comps = ctx.competitors.map((c) => c.name);
  const customers = ctx.brand.targetCustomers.length ? ctx.brand.targetCustomers : ["small businesses", "startups", "enterprises"];
  const country = countryName(ctx.market.country);
  const why = (s: string) => s;
  const t: Template[] = [
    // COMMERCIAL
    { text: `Best ${category}`, intent: "COMMERCIAL", cluster: category, priority: 5, reason: why("Core category query; buyers start their shortlist here.") },
    ...customers.slice(0, 3).map((c): Template => ({ text: `Best ${category} for ${c}`, intent: "COMMERCIAL", cluster: category, priority: 5, reason: `Segment-specific shortlist query for ${c}.` })),
    { text: `Top ${category} tools`, intent: "COMMERCIAL", cluster: category, priority: 4, reason: "Common variant of the core category query." },
    { text: `Most recommended ${category}`, intent: "COMMERCIAL", cluster: category, priority: 4, reason: "Asks the assistant for a recommendation directly." },
    { text: `Best ${category} in ${country}`, intent: "COMMERCIAL", cluster: category, priority: 4, reason: `Market-specific shortlist for ${country}.` },
    { text: `Easiest ${category} to use`, intent: "COMMERCIAL", cluster: category, priority: 3, reason: "Usability-led shortlist query." },
    { text: `Best ${category} for growing teams`, intent: "COMMERCIAL", cluster: category, priority: 3, reason: "Scale-led shortlist query." },
    // TRANSACTIONAL
    { text: `Affordable ${category} for ${customers[0]}`, intent: "TRANSACTIONAL", cluster: "Pricing", priority: 4, reason: "Price-sensitive buyer close to a decision." },
    { text: `${category} pricing comparison`, intent: "TRANSACTIONAL", cluster: "Pricing", priority: 4, reason: "Buyer comparing costs before purchase." },
    { text: `Free ${category} options`, intent: "TRANSACTIONAL", cluster: "Pricing", priority: 3, reason: "Free-plan seekers often convert to paid." },
    { text: `${category} with a free trial`, intent: "TRANSACTIONAL", cluster: "Pricing", priority: 3, reason: "Trial intent signals readiness to evaluate." },
    { text: `Cheapest ${category} for a small team`, intent: "TRANSACTIONAL", cluster: "Pricing", priority: 3, reason: "Budget-driven purchase query." },
    // INFORMATIONAL
    { text: `How to choose ${category}`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 3, reason: "Early-stage research that shapes the shortlist." },
    { text: `What features should ${category} have`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 2, reason: "Defines evaluation criteria early." },
    ...ctx.topics.slice(0, 2).map((topic): Template => ({ text: `How to improve ${topic.toLowerCase()}`, intent: "INFORMATIONAL", cluster: topic.slice(0, 60), priority: 2, reason: `Problem-led query on a topic the brand covers.` })),
    { text: `Common mistakes when adopting ${category}`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 2, reason: "Educational query where expert brands get cited." },
    { text: `Is ${category} worth it for ${customers[0]}`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 2, reason: "Validation question before buying." },
    { text: `How to get the most out of ${category}`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 2, reason: "Adoption question where expert content gets cited." },
    { text: `How to switch to a new ${category}`, intent: "INFORMATIONAL", cluster: "Buying guide", priority: 2, reason: "Migration research ahead of a purchase." },
    // COMPARISON
    ...comps.slice(0, 3).map((c): Template => ({ text: `${brand} vs ${c}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 4, reason: `Direct comparison against ${c}.` })),
    ...(comps.length >= 2 ? [{ text: `${comps[0]} vs ${comps[1]}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 3, reason: "Competitor comparison where the brand could be suggested." } as Template] : []),
    ...(comps.length >= 3 ? [{ text: `${comps[1]} vs ${comps[2]}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 3, reason: "Competitor comparison where the brand could be suggested." } as Template] : []),
    { text: `Compare the top ${category} options`, intent: "COMPARISON", cluster: "Head-to-head", priority: 3, reason: "Open comparison query." },
    { text: `${brand} vs other ${category}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 3, reason: "How AI positions the brand against the field." },
    { text: `${category} comparison for ${customers[0]}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 2, reason: "Segment-specific comparison query." },
    { text: `Pros and cons of the leading ${category}`, intent: "COMPARISON", cluster: "Head-to-head", priority: 2, reason: "Comparative evaluation across vendors." },
    { text: `Side-by-side comparison of ${category} features`, intent: "COMPARISON", cluster: "Head-to-head", priority: 2, reason: "Feature-led comparison query." },
    // ALTERNATIVE
    ...comps.slice(0, 4).map((c): Template => ({ text: `${c} alternatives`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 4, reason: `Buyers leaving ${c} are switching-ready.` })),
    ...comps.slice(0, 2).map((c): Template => ({ text: `Cheaper alternatives to ${c}`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 4, reason: `Price-driven switchers from ${c}.` })),
    { text: `Alternatives to the most popular ${category}`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 3, reason: "Switching intent without a named incumbent." },
    { text: `Best ${category} alternatives for ${customers[0]}`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 3, reason: "Segment-specific switching query." },
    { text: `Simpler alternatives to enterprise ${category}`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 3, reason: "Buyers moving away from heavyweight tools." },
    { text: `Open-source alternatives to paid ${category}`, intent: "ALTERNATIVE", cluster: "Alternatives", priority: 2, reason: "Cost-driven switching query." },
    // BRANDED
    { text: `Is ${brand} good?`, intent: "BRANDED", cluster: "Brand", priority: 3, reason: "Reputation check by evaluating buyers." },
    { text: `${brand} reviews`, intent: "BRANDED", cluster: "Brand", priority: 3, reason: "Social proof query before purchase." },
    { text: `${brand} pricing`, intent: "BRANDED", cluster: "Brand", priority: 4, reason: "High-intent branded pricing query." },
    { text: `What is ${brand} used for?`, intent: "BRANDED", cluster: "Brand", priority: 2, reason: "Checks how AI describes the brand." },
    { text: `${brand} pros and cons`, intent: "BRANDED", cluster: "Brand", priority: 3, reason: "Balanced evaluation query." },
  ];
  // Templates starting with a lowercase category read like fragments; capitalize the first letter.
  return t.map((x) => ({ ...x, text: x.text.charAt(0).toUpperCase() + x.text.slice(1) }));
}

export interface InitialPromptResult {
  prompts: FinalPrompt[];
  method: "AI" | "AI_WITH_TEMPLATES" | "TEMPLATES";
  usage: StructuredUsage[];
  aiError?: string;
  rejectedCount: number;
}

/**
 * Builds the initial prompt set: one AI call for the full mix, one targeted
 * top-up for any intent left short, then templates (labelled TEMPLATE) to
 * fill what remains. Templates are English-only; for other languages the
 * shortfall is left for the user rather than mixing languages.
 */
export async function buildInitialPrompts(llm: StructuredLLMClient | null, ctx: PromptContext, quotas: Quotas = PROMPT_DISTRIBUTION): Promise<InitialPromptResult> {
  const log = logger.child({ component: "onboarding.prompts" });
  const usage: StructuredUsage[] = [];
  let accepted: FinalPrompt[] = [];
  let missing = quotas;
  let rejectedCount = 0;
  let aiError: string | undefined;

  if (llm) {
    try {
      for (let round = 0; round < 2 && sumQuotas(missing) > 0; round++) {
        const res = await generatePromptsWithAI(llm, ctx, missing, accepted.map((p) => p.text));
        usage.push(res.usage);
        const fin = finalizePrompts(res.prompts, ctx, quotas, accepted);
        accepted = [...accepted, ...fin.accepted];
        missing = fin.missing;
        rejectedCount += fin.rejected.length;
        log.info("onboarding.prompts.round", { round, accepted: fin.accepted.length, rejected: fin.rejected.length, missing: sumQuotas(missing), ...fin.adjustments });
      }
    } catch (error) {
      aiError = error instanceof StructuredOutputError ? error.failure : "UNKNOWN";
      if (error instanceof StructuredOutputError) usage.push(error.usage);
      log.error("onboarding.prompts.ai_failed", { error });
    }
  }

  const aiCount = accepted.length;
  if (sumQuotas(missing) > 0 && ctx.market.language === "en") {
    const templates = templatePrompts(ctx).map((t) => ({ ...t, country: ctx.market.country, language: ctx.market.language }));
    const fin = finalizePrompts(templates, ctx, quotas, accepted, "TEMPLATE");
    accepted = [...accepted, ...fin.accepted];
    missing = fin.missing;
  }

  const order = new Map(PROMPT_INTENTS.map((i, idx) => [i, idx]));
  accepted.sort((a, b) => order.get(a.intent)! - order.get(b.intent)! || b.priority - a.priority);
  const method = aiCount === 0 ? "TEMPLATES" : aiCount === accepted.length ? "AI" : "AI_WITH_TEMPLATES";
  return { prompts: accepted, method, usage, aiError, rejectedCount };
}
