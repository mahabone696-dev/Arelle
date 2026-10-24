/**
 * Opportunity engine: deterministic rules over analyzed answers.
 *
 * Pure (no I/O) so every rule is unit-tested on realistic scenarios. Each
 * opportunity carries the evidence behind it; impact (0–100) is a priority
 * signal for ordering work, not a forecast of ranking changes.
 */
import type { OpportunityType, PromptIntent } from "@/generated/prisma/enums";
import type { ResolvedWeights } from "@/server/scoring/visibility";
import { citationDomains, groupBy, latestPerProvider, subjectMetrics, type AnswerRow } from "@/server/dashboard/aggregate";
import { matchPage, type SitePage } from "./pages";

export interface EnginePrompt {
  id: string;
  text: string;
  intent: PromptIntent;
  priority: number;
}

export interface EngineCompetitor {
  id: string;
  name: string;
  domain: string | null;
}

export interface EngineInput {
  brand: { name: string; domain: string; industry?: string | null };
  competitors: EngineCompetitor[];
  prompts: EnginePrompt[];
  /** Analyzed answers in the evaluation window (oldest first). */
  answers: AnswerRow[];
  /** Crawled page summaries; null when the site was never analyzed (CONTENT_GAP is then skipped). */
  pages: SitePage[] | null;
  weights: ResolvedWeights;
}

export interface CompetitorCount {
  id: string;
  name: string;
  answers: number;
}

export interface OpportunityEvidence {
  answers: number;
  engines?: number;
  enginesLosing?: number;
  yourMentions?: number;
  yourScore?: number;
  leader?: { id: string; name: string; score: number } | null;
  competitors?: CompetitorCount[];
  sources?: { domain: string; answers: number; url: string }[];
  averagePosition?: number | null;
  outrankedBy?: { id: string; name: string; answers: number } | null;
  /** Higher-impact opportunities whose recommendations already cover this one. */
  coveredBy?: { fingerprint: string; title: string }[];
  /** Points the overall score would move if this prompt matched the leader (arithmetic, not a forecast). */
  potentialGain?: number;
  page?: { url: string; title: string | null } | null;
  intent?: PromptIntent;
  prompts?: number;
  competitorRate?: number;
  yourRate?: number;
  domain?: string;
  withCompetitor?: number;
  withPrimary?: number;
  gapScore?: number;
  promptIds?: string[];
}

export interface OpportunityDraft {
  type: OpportunityType;
  fingerprint: string;
  promptId: string | null;
  title: string;
  description: string;
  evidence: OpportunityEvidence;
  impactScore: number;
  confidenceScore: number;
}

/** How commercially valuable each intent is when you're missing from it. */
export const INTENT_WEIGHT: Record<PromptIntent, number> = {
  TRANSACTIONAL: 1,
  COMMERCIAL: 0.9,
  COMPARISON: 0.9,
  ALTERNATIVE: 0.85,
  BRANDED: 0.7,
  INFORMATIONAL: 0.4,
};

const INTENT_PLURAL: Record<PromptIntent, string> = {
  TRANSACTIONAL: "transactional prompts",
  COMMERCIAL: "commercial prompts",
  COMPARISON: "comparison prompts",
  ALTERNATIVE: "“alternatives” prompts",
  BRANDED: "branded prompts",
  INFORMATIONAL: "informational prompts",
};

const PAGE_INTENTS: PromptIntent[] = ["COMMERCIAL", "TRANSACTIONAL", "COMPARISON", "ALTERNATIVE"];

export const RULES = {
  /** Fewer answers than this for a prompt and we don't draw conclusions. */
  minPromptAnswers: 2,
  /** LOST_PROMPT also needs you absent from at least this share of the window's answers. */
  lostAbsentShare: 0.5,
  positionMinMentionRate: 0.3,
  positionMaxAverage: 2.5,
  positionOutrankedShare: 0.6,
  dominanceMinPrompts: 2,
  dominanceMinAnswers: 6,
  dominanceMinRate: 0.4,
  dominanceMargin: 0.2,
  dominanceRatio: 1.5,
  citationMinAnswers: 3,
  citationMinGap: 35,
  citationMaxPrimaryShare: 0.5,
  maxCitationGaps: 10,
  contentGapMinPriority: 4,
} as const;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const score100 = (n: number) => Math.round(100 * clamp01(n));
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (n: number) => `${Math.round(n * 100)}%`;
/** Confidence grows with sample size: 2 answers → 0.29, 6 → 0.55, 15 → 0.75, 30 → 0.86. */
const confidence = (n: number) => Math.round((n / (n + 5)) * 100) / 100;
const priority01 = (p: number) => clamp01((p - 1) / 4);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Competitors named in the prompt text itself ("HubSpot alternatives", "HubSpot vs Salesforce"). */
export function competitorsInPrompt(text: string, competitors: EngineCompetitor[]): EngineCompetitor[] {
  const t = ` ${text.toLowerCase()} `;
  return competitors.filter((c) => new RegExp(`[^\\p{L}\\p{N}]${c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}\\p{N}]`, "u").test(t));
}

function countCompetitors(answers: AnswerRow[], names: Map<string, string>): CompetitorCount[] {
  const counts = new Map<string, number>();
  for (const a of answers) for (const id of new Set(a.mentions.filter((m) => m.competitorId).map((m) => m.competitorId!))) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, n]) => ({ id, name: names.get(id) ?? "A competitor", answers: n }))
    .sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name));
}

function topSources(answers: AnswerRow[], limit = 3) {
  const byDomain = groupBy(
    answers.flatMap((a) => [...new Map(a.citations.filter((c) => c.ownerType === "THIRD_PARTY").map((c) => [c.domain, c])).values()]),
    (c) => c.domain,
  );
  return [...byDomain.entries()]
    .map(([domain, cs]) => {
      const url = [...groupBy(cs, (c) => c.url).entries()].sort((a, b) => b[1].length - a[1].length)[0]![0];
      return { domain, answers: cs.length, url };
    })
    .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain))
    .slice(0, limit);
}

function promptOpportunities(input: EngineInput, prompt: EnginePrompt, rows: AnswerRow[], ctx: { names: Map<string, string>; engines: number }): OpportunityDraft[] {
  const { brand, weights } = input;
  const n = rows.length;
  if (n < RULES.minPromptAnswers) return [];
  const latest = latestPerProvider(rows);
  const mine = subjectMetrics(rows, null, weights);
  const yourMentions = rows.filter((a) => a.mentions.some((m) => m.isPrimaryBrand)).length;
  const absent = rows.filter((a) => !a.mentions.some((m) => m.isPrimaryBrand));
  const competitorScores = input.competitors.map((c) => ({ id: c.id, name: c.name, score: subjectMetrics(rows, c.id, weights).visibilityScore })).sort((a, b) => b.score - a.score);
  const leader = competitorScores[0] && competitorScores[0].score > 0 ? competitorScores[0] : null;
  const potentialGain = leader && leader.score > mine.visibilityScore ? round1((leader.score - mine.visibilityScore) / Math.max(1, input.prompts.length)) : 0;
  const p = priority01(prompt.priority);
  const w = INTENT_WEIGHT[prompt.intent];
  const conf = confidence(n);
  const page = input.pages ? matchPage(prompt.text, input.pages, [brand.name, ...input.competitors.map((c) => c.name)]) : undefined;
  const out: OpportunityDraft[] = [];

  const latestAbsent = latest.filter((a) => !a.mentions.some((m) => m.isPrimaryBrand));
  const latestWithCompetitor = latestAbsent.filter((a) => a.mentions.some((m) => !m.isPrimaryBrand));
  const lost = latestAbsent.length === latest.length && latestWithCompetitor.length > 0 && absent.length / n >= RULES.lostAbsentShare;

  if (lost) {
    const competitors = countCompetitors(absent, ctx.names);
    const sources = topSources(absent);
    const coverage = latestWithCompetitor.length / Math.max(1, ctx.engines);
    const dominance = (leader?.score ?? 0) / 100;
    const citationStrength = absent.filter((a) => a.citations.some((c) => c.ownerType === "THIRD_PARTY")).length / Math.max(1, absent.length);
    const top = competitors.slice(0, 3).map((c) => c.name);
    out.push({
      type: "LOST_PROMPT",
      fingerprint: `LOST_PROMPT:${prompt.id}`,
      promptId: prompt.id,
      title: `Missing from “${prompt.text}”`,
      description:
        `${brand.name} is absent from ${absent.length} of ${n} AI answers for this prompt` +
        (latestWithCompetitor.length ? ` and from the latest answer of ${plural(latestAbsent.length, "engine")}` : "") +
        (top.length ? `; ${top.join(", ")} ${top.length === 1 ? "appears" : "appear"} instead.` : "."),
      evidence: { answers: n, engines: latest.length, enginesLosing: latestWithCompetitor.length, yourMentions, yourScore: mine.visibilityScore, leader, competitors, sources, potentialGain, page: page ?? null, intent: prompt.intent },
      impactScore: score100(0.25 * p + 0.25 * w + 0.2 * coverage + 0.2 * dominance + 0.1 * citationStrength),
      confidenceScore: conf,
    });
    return out; // a lost prompt subsumes position/content gaps for the same prompt
  }

  // Position gap: you're mentioned but typically listed below competitors.
  const both = rows.filter((a) => a.mentions.some((m) => m.isPrimaryBrand) && a.mentions.some((m) => !m.isPrimaryBrand));
  const outranked = new Map<string, number>();
  let outrankedAnswers = 0;
  for (const a of both) {
    const me = a.mentions.find((m) => m.isPrimaryBrand)!;
    const above = a.mentions.filter((m) => m.competitorId && m.position < me.position);
    if (above.length) outrankedAnswers++;
    for (const id of new Set(above.map((m) => m.competitorId!))) outranked.set(id, (outranked.get(id) ?? 0) + 1);
  }
  const [topOut] = [...outranked.entries()].sort((a, b) => b[1] - a[1]);
  const outrankedShare = both.length ? outrankedAnswers / both.length : 0;
  const outrankedBy = topOut ? { id: topOut[0], name: ctx.names.get(topOut[0]) ?? "A competitor", answers: topOut[1] } : null;
  const positionGap = mine.mentionRate >= RULES.positionMinMentionRate && mine.averagePosition !== null && (mine.averagePosition >= RULES.positionMaxAverage || outrankedShare >= RULES.positionOutrankedShare) && outrankedBy !== null;

  // Content gap: an important commercial prompt with no page on your site that targets it.
  // It subsumes a position gap on the same prompt (the fix is a page, not an update).
  const winning = latest.filter((a) => a.mentions.some((m) => m.isPrimaryBrand && m.position === 1)).length * 2 > latest.length;
  if (page === null && PAGE_INTENTS.includes(prompt.intent) && prompt.priority >= RULES.contentGapMinPriority && !winning) {
    out.push({
      type: "CONTENT_GAP",
      fingerprint: `CONTENT_GAP:${prompt.id}`,
      promptId: prompt.id,
      title: `No page targets “${prompt.text}”`,
      description:
        `This is a priority ${prompt.priority} ${prompt.intent.toLowerCase()} prompt, but none of the crawled pages on ${brand.domain} address it directly. ${brand.name} is mentioned in ${pct(mine.mentionRate)} of its answers` +
        (positionGap ? `, at an average position of ${mine.averagePosition!.toFixed(1)}.` : "."),
      evidence: { answers: n, yourMentions, yourScore: mine.visibilityScore, averagePosition: mine.averagePosition, outrankedBy, leader, competitors: countCompetitors(rows, ctx.names), potentialGain, page: null, intent: prompt.intent },
      impactScore: score100(0.8 * (0.35 * p + 0.35 * w + 0.3 * (1 - mine.mentionRate))),
      confidenceScore: Math.min(conf, 0.7), // page matching is heuristic
    });
  } else if (positionGap) {
    out.push({
      type: "POSITION_GAP",
      fingerprint: `POSITION_GAP:${prompt.id}`,
      promptId: prompt.id,
      title: `Listed below competitors for “${prompt.text}”`,
      description: `${brand.name} is mentioned in ${pct(mine.mentionRate)} of answers but at an average position of ${mine.averagePosition!.toFixed(1)}; ${outrankedBy!.name} is listed above it in ${plural(outrankedBy!.answers, "answer")}.`,
      evidence: { answers: n, yourMentions, yourScore: mine.visibilityScore, averagePosition: mine.averagePosition, outrankedBy, leader, potentialGain, page: page ?? null, intent: prompt.intent },
      impactScore: score100(0.75 * (0.3 * p + 0.3 * w + 0.4 * outrankedShare)),
      confidenceScore: conf,
    });
  }
  return out;
}

/**
 * A competitor appearing in far more answers than you across one intent.
 * Prompts that name the competitor ("HubSpot alternatives") are excluded for
 * that competitor — of course the answers mention it.
 */
function dominanceOpportunities(input: EngineInput, byPrompt: Map<string, AnswerRow[]>): OpportunityDraft[] {
  const out: OpportunityDraft[] = [];
  const byIntent = groupBy(input.prompts.filter((p) => byPrompt.has(p.id)), (p) => p.intent);
  for (const [intent, groupPrompts] of byIntent) {
    const best = input.competitors
      .map((c) => {
        const prompts = groupPrompts.filter((p) => !competitorsInPrompt(p.text, [c]).length);
        const rows = prompts.flatMap((p) => byPrompt.get(p.id)!);
        return { c, prompts, rows, rate: rows.length ? subjectMetrics(rows, c.id, input.weights).mentionRate : 0, yourRate: rows.length ? subjectMetrics(rows, null, input.weights).mentionRate : 0 };
      })
      .filter((x) => x.prompts.length >= RULES.dominanceMinPrompts && x.rows.length >= RULES.dominanceMinAnswers)
      .sort((a, b) => b.rate - b.yourRate - (a.rate - a.yourRate) || b.rate - a.rate)[0];
    if (!best || best.rate < RULES.dominanceMinRate || best.rate - best.yourRate < RULES.dominanceMargin || best.rate < RULES.dominanceRatio * best.yourRate) continue;
    const { c, prompts, rows, rate, yourRate } = best;
    const avgPriority = prompts.reduce((s, p) => s + p.priority, 0) / prompts.length;
    out.push({
      type: "COMPETITOR_DOMINANCE",
      fingerprint: `COMPETITOR_DOMINANCE:${intent}:${c.id}`,
      promptId: null,
      title: `${c.name} dominates ${INTENT_PLURAL[intent]}`,
      description: `${c.name} appears in ${pct(rate)} of answers to ${plural(prompts.length, INTENT_PLURAL[intent].replace(/s$/, ""), INTENT_PLURAL[intent])} that don't name it; ${brand(input)} appears in ${pct(yourRate)}.`,
      evidence: {
        answers: rows.length,
        intent,
        prompts: prompts.length,
        promptIds: prompts.map((p) => p.id),
        competitorRate: Math.round(rate * 100) / 100,
        yourRate: Math.round(yourRate * 100) / 100,
        leader: { id: c.id, name: c.name, score: subjectMetrics(rows, c.id, input.weights).visibilityScore },
        sources: topSources(rows.filter((a) => a.mentions.some((m) => m.competitorId === c.id) && !a.mentions.some((m) => m.isPrimaryBrand))),
      },
      impactScore: score100(0.3 * priority01(avgPriority) + 0.25 * INTENT_WEIGHT[intent] + 0.3 * clamp01((rate - yourRate) / 0.6) + 0.15 * (prompts.length / input.prompts.length)),
      confidenceScore: confidence(rows.length),
    });
  }
  return out;
}

const brand = (input: EngineInput) => input.brand.name;

function citationOpportunities(input: EngineInput, answers: AnswerRow[]): OpportunityDraft[] {
  const promptById = new Map(input.prompts.map((p) => [p.id, p]));
  return citationDomains(answers)
    .filter((d) => d.gapScore !== null && d.gapScore >= RULES.citationMinGap && d.answers >= RULES.citationMinAnswers && d.withPrimary / d.answers <= RULES.citationMaxPrimaryShare)
    .sort((a, b) => b.gapScore! - a.gapScore! || b.answers - a.answers)
    .slice(0, RULES.maxCitationGaps)
    .map((d) => {
      const citing = answers.filter((a) => a.citations.some((c) => c.domain === d.domain));
      const promptIds = [...new Set(citing.map((a) => a.promptId))];
      const avgIntent = promptIds.reduce((s, id) => s + INTENT_WEIGHT[promptById.get(id)?.intent ?? "INFORMATIONAL"], 0) / Math.max(1, promptIds.length);
      const url = [...groupBy(citing.flatMap((a) => a.citations.filter((c) => c.domain === d.domain)), (c) => c.url).entries()].sort((a, b) => b[1].length - a[1].length)[0]![0];
      return {
        type: "CITATION_GAP" as const,
        fingerprint: `CITATION_GAP:${d.domain}`,
        promptId: null,
        title: `${d.domain} is cited alongside competitors, rarely with you`,
        description: `${d.domain} is cited in ${d.answers} answers: ${d.withCompetitor} mention a competitor, ${d.withPrimary} mention ${input.brand.name}.`,
        evidence: { answers: d.answers, domain: d.domain, withCompetitor: d.withCompetitor, withPrimary: d.withPrimary, gapScore: d.gapScore!, promptIds, prompts: promptIds.length, competitors: countCompetitors(citing, new Map(input.competitors.map((c) => [c.id, c.name]))), sources: [{ domain: d.domain, answers: d.answers, url }] },
        impactScore: score100(0.5 * (d.gapScore! / 100) + 0.3 * (promptIds.length / Math.max(1, input.prompts.length)) + 0.2 * avgIntent),
        confidenceScore: confidence(d.answers),
      };
    });
}

/** All opportunities for a project, highest impact first. */
export function detectOpportunities(input: EngineInput): OpportunityDraft[] {
  const names = new Map(input.competitors.map((c) => [c.id, c.name]));
  const promptIds = new Set(input.prompts.map((p) => p.id));
  const answers = input.answers.filter((a) => promptIds.has(a.promptId));
  const byPrompt = groupBy(answers, (a) => a.promptId);
  const engines = new Set(answers.map((a) => a.providerId)).size;
  const drafts = [
    ...input.prompts.flatMap((p) => promptOpportunities(input, p, byPrompt.get(p.id) ?? [], { names, engines })),
    ...dominanceOpportunities(input, byPrompt),
    ...citationOpportunities(input, answers),
  ];
  return drafts.sort((a, b) => b.impactScore - a.impactScore || a.fingerprint.localeCompare(b.fingerprint));
}
