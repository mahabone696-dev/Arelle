import type { CrawlResult } from "@/server/crawler/crawler";
import { generateStructured, type StructuredUsage } from "@/server/ai/structured";
import type { StructuredLLMClient } from "@/server/ai/types";
import { countryName, languageName } from "@/lib/i18n";
import { brandExtractionSchema, type BrandExtraction } from "./schemas";
import { buildSiteContext, UNTRUSTED_CONTENT_RULES } from "./site-context";

export interface Market {
  country: string;
  language: string;
}

export async function extractBrandWithAI(llm: StructuredLLMClient, crawl: CrawlResult, market: Market): Promise<{ brand: BrandExtraction; usage: StructuredUsage }> {
  const { data, usage } = await generateStructured(llm, {
    schema: brandExtractionSchema,
    schemaName: "brand_profile",
    maxOutputTokens: 2000,
    system: [
      "You analyze company websites to build an accurate brand profile for AI search visibility tracking.",
      UNTRUSTED_CONTENT_RULES,
      "Only state what the website supports. Use empty strings or empty arrays when unknown; do not invent facts.",
      "brandName: the company's or product's public brand name (not a tagline).",
      "industry: a short category phrase buyers would search for, e.g. \"CRM software\" or \"project management software\".",
      "products/services: concrete offerings named on the site. targetCustomers: audience segments. markets: countries/regions served.",
      "topics: 5-15 short topical themes the brand wants to be found for.",
      `Write all values in ${languageName(market.language)}.`,
    ].join("\n"),
    user: `Primary market: ${countryName(market.country)} (${market.country}). Language: ${languageName(market.language)}.\n\n${buildSiteContext(crawl)}`,
  });
  return { brand: data, usage };
}

const SEPARATORS = /\s+[|–—:·•-]\s+/;

/** Brand name from structured data, og:site_name, or the title segment that matches the domain. */
export function guessBrandName(crawl: CrawlResult): string {
  const home = crawl.pages[0]!;
  const org = crawl.pages.flatMap((p) => p.jsonLd).find((e) => /Organization|Corporation/i.test(e.type) && e.name);
  if (org?.name) return org.name;
  if (home.siteName) return home.siteName;
  const label = crawl.site.split(".")[0]!.toLowerCase();
  const segments = home.title.split(SEPARATORS).map((s) => s.trim()).filter(Boolean);
  const match = segments.find((s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").includes(label.replace(/[^a-z0-9]/g, "")));
  if (match && match.length <= 40) return match;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * No-AI fallback: only what can be read directly from the site's metadata.
 * Fields that need interpretation (industry, customers, markets, topics) stay empty
 * for the user to fill in.
 */
export function extractBrandDeterministic(crawl: CrawlResult): BrandExtraction {
  const home = crawl.pages[0]!;
  const products = [...new Set(crawl.pages.flatMap((p) => p.jsonLd).filter((e) => /Product|SoftwareApplication/i.test(e.type) && e.name).map((e) => e.name!))];
  const raw = {
    brandName: guessBrandName(crawl).slice(0, 80),
    description: (home.description || crawl.pages.find((p) => p.description)?.description || "").slice(0, 600),
    industry: "",
    products: products.slice(0, 12),
    services: [],
    targetCustomers: [],
    markets: [],
    // Headings are mostly marketing copy, not topics; without a model we leave this for the user.
    topics: [],
  };
  return brandExtractionSchema.parse(raw);
}
