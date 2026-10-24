/**
 * Response analysis: one AI answer → which tracked brands it mentions, in
 * what order, with what sentiment and recommendation strength, and which
 * sources it cites. Deterministic by default; the output is validated with
 * Zod before it is stored.
 */
import { z } from "zod";
import { matchBrands, MENTION_CONFIDENCE_THRESHOLD, type BrandEntity } from "./brand-matcher";
import { normalizeCitations, type OwnerLookup, type RawCitation } from "./citations";
import { brandSentiment, recommendationStrength } from "./sentiment";

/** Bump when analysis logic changes; old rows stay, new rows get the new version. */
export const ANALYSIS_VERSION = 1;

const mentionSchema = z.object({
  key: z.string(),
  name: z.string(),
  competitorId: z.string().nullable(),
  domain: z.string().nullable(),
  /** 1-based rank among brands mentioned in this answer. */
  position: z.number().int().min(1),
  occurrences: z.number().int().min(1),
  sentiment: z.number().min(-1).max(1).nullable(),
  recommendationStrength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  snippet: z.string().max(500).nullable(),
});

export const analysisResultSchema = z.object({
  analysisVersion: z.number().int(),
  method: z.enum(["DETERMINISTIC", "AI"]),
  primaryBrand: z.object({
    mentioned: z.boolean(),
    position: z.number().int().min(1).nullable(),
    sentiment: z.number().min(-1).max(1).nullable(),
    recommendationStrength: z.number().min(0).max(1).nullable(),
    cited: z.boolean(),
  }),
  mentions: z.array(mentionSchema),
  competitors: z.array(mentionSchema.extend({ cited: z.boolean() })),
  /** Tracked brands (primary + competitors) mentioned — the share-of-voice denominator. */
  brandsMentionedCount: z.number().int().min(0),
  citations: z.array(
    z.object({
      url: z.string(),
      normalizedUrl: z.string(),
      domain: z.string(),
      title: z.string().nullable(),
      position: z.number().int().min(1),
      ownerType: z.enum(["PRIMARY", "COMPETITOR", "THIRD_PARTY"]),
      competitorId: z.string().nullable(),
    }),
  ),
  /** Brand matches below the confidence threshold (e.g. "Close the deal"), kept for transparency. */
  lowConfidence: z.array(z.object({ name: z.string(), confidence: z.number() })),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type MentionResult = z.infer<typeof mentionSchema>;

export interface AnalyzeInput {
  normalizedText: string;
  rawText: string;
  language: string;
  providerCitations: RawCitation[];
}

export interface BrandContext {
  primary: { name: string; aliases: string[]; domain: string | null };
  competitors: Array<{ id: string; name: string; aliases: string[]; domain: string | null }>;
}

export function entitiesFor(ctx: BrandContext): BrandEntity[] {
  return [
    { key: "primary", name: ctx.primary.name, aliases: ctx.primary.aliases, domain: ctx.primary.domain, isPrimary: true },
    ...ctx.competitors.map((c) => ({ key: `competitor:${c.id}`, name: c.name, aliases: c.aliases, domain: c.domain, isPrimary: false, competitorId: c.id })),
  ];
}

export function analyzeResponse(input: AnalyzeInput, ctx: BrandContext): AnalysisResult {
  const entities = entitiesFor(ctx);
  const matches = matchBrands(input.normalizedText, entities);
  const confident = matches.filter((m) => m.confidence >= MENTION_CONFIDENCE_THRESHOLD);
  const owners: OwnerLookup = {
    primaryDomain: ctx.primary.domain,
    competitorDomains: ctx.competitors.filter((c) => c.domain).map((c) => ({ competitorId: c.id, domain: c.domain! })),
  };
  const citations = normalizeCitations(input.providerCitations, input.rawText, owners);

  const mentions: MentionResult[] = confident.map((m, i) => {
    const entity = entities.find((e) => e.key === m.key)!;
    const names = [entity.name, ...entity.aliases, ...(entity.domain ? [entity.domain] : [])];
    const sentiment = brandSentiment(m.sentences, names, input.language);
    return {
      key: m.key,
      name: m.name,
      competitorId: m.competitorId ?? null,
      domain: m.domain,
      position: i + 1,
      occurrences: m.occurrences,
      sentiment,
      recommendationStrength: recommendationStrength(i + 1, m.sentences, sentiment),
      confidence: m.confidence,
      snippet: m.sentences[0]?.slice(0, 500) ?? null,
    };
  });

  const primary = mentions.find((m) => m.key === "primary");
  const result: AnalysisResult = {
    analysisVersion: ANALYSIS_VERSION,
    method: "DETERMINISTIC",
    primaryBrand: {
      mentioned: !!primary,
      position: primary?.position ?? null,
      sentiment: primary?.sentiment ?? null,
      recommendationStrength: primary?.recommendationStrength ?? null,
      cited: citations.some((c) => c.ownerType === "PRIMARY"),
    },
    mentions,
    competitors: mentions.filter((m) => m.key !== "primary").map((m) => ({ ...m, cited: citations.some((c) => c.competitorId === m.competitorId) })),
    brandsMentionedCount: mentions.length,
    citations,
    lowConfidence: matches.filter((m) => m.confidence < MENTION_CONFIDENCE_THRESHOLD).map((m) => ({ name: m.name, confidence: m.confidence })),
  };
  return analysisResultSchema.parse(result);
}
