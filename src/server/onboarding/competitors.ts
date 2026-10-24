import { generateStructured, type StructuredUsage } from "@/server/ai/structured";
import type { StructuredLLMClient } from "@/server/ai/types";
import { normalizeDomain } from "@/lib/domain";
import { countryName, languageName } from "@/lib/i18n";
import type { Market } from "./brand-extraction";
import { competitorSuggestionsSchema, type CompetitorSuggestion } from "./schemas";

export interface BrandContext {
  name: string;
  domain: string;
  industry: string;
  description: string;
  products: string[];
  targetCustomers: string[];
  aliases: string[];
}

export interface FinalCompetitor {
  name: string;
  domain: string | null;
  reason: string;
  confidence: number;
}

export async function suggestCompetitorsWithAI(llm: StructuredLLMClient, brand: BrandContext, market: Market, count = 5) {
  const { data, usage } = await generateStructured(llm, {
    schema: competitorSuggestionsSchema,
    schemaName: "competitor_suggestions",
    maxOutputTokens: 1500,
    system: [
      "You identify the direct competitors a buyer would compare against a given company when asking an AI assistant for recommendations.",
      `Return ${count + 2} competitors, most direct first. Prefer companies active in ${countryName(market.country)}.`,
      "Only real, currently operating companies. domain: the competitor's primary website domain (e.g. \"example.com\"), or \"\" if unsure.",
      "reason: one short sentence explaining the overlap. confidence: 0–1 that this is a direct competitor.",
      "Never include the company itself.",
      `Write reasons in ${languageName(market.language)}.`,
    ].join("\n"),
    user: JSON.stringify({ company: brand.name, domain: brand.domain, category: brand.industry, description: brand.description, products: brand.products, targetCustomers: brand.targetCustomers }),
  });
  return { competitors: finalizeCompetitors(data.competitors, brand, count), usage } satisfies { competitors: FinalCompetitor[]; usage: StructuredUsage };
}

const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Normalize domains, drop the brand itself and duplicates, keep the top N by confidence. */
export function finalizeCompetitors(raw: CompetitorSuggestion[], brand: Pick<BrandContext, "name" | "domain" | "aliases">, count = 5): FinalCompetitor[] {
  const brandKeys = new Set([brand.name, ...brand.aliases].map(nameKey));
  const brandSite = brand.domain.replace(/^www\./, "");
  const seenNames = new Set<string>();
  const seenDomains = new Set<string>();
  const out: FinalCompetitor[] = [];
  for (const c of [...raw].sort((a, b) => b.confidence - a.confidence)) {
    const key = nameKey(c.name);
    if (!key || brandKeys.has(key) || seenNames.has(key)) continue;
    const normalized = c.domain ? normalizeDomain(c.domain) : null;
    const domain = normalized?.ok ? normalized.domain : null;
    if (domain && (domain === brandSite || domain.endsWith(`.${brandSite}`) || seenDomains.has(domain))) continue;
    seenNames.add(key);
    if (domain) seenDomains.add(domain);
    out.push({ name: c.name.trim(), domain, reason: c.reason, confidence: Math.round(c.confidence * 100) / 100 });
    if (out.length >= count) break;
  }
  return out;
}
