import type { CrawlResult } from "@/server/crawler/crawler";

/**
 * Without an AI model, use the homepage's own short headline as the category
 * ("CRM software for small teams"). Long marketing sentences are rejected:
 * a wrong category would produce misleading prompts, so we fail instead.
 */
const GENERIC = /^(home|homepage|home page|index|welcome\b.*|official (web)?site|start|main page|log ?in|sign ?in)$/i;
const DANGLING = /\b(to|for|the|a|an|and|of|with|in|by|your|our)$/i;

export function guessCategory(crawl: CrawlResult, brandName: string): string {
  const home = crawl.pages[0];
  if (!home) return "";
  const brandRe = new RegExp(brandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const candidates = [...home.headings.h1, ...home.title.split(/\s[|—–-]\s/)].map((t) => t.replace(brandRe, "").replace(/^[\s:|—–-]+|[\s:|—–.!-]+$/g, "").trim());
  return candidates.find((c) => /^[\p{L}\p{N}][\p{L}\p{N}\s&'-]{2,60}$/u.test(c) && c.split(/\s+/).length <= 6 && !GENERIC.test(c) && !DANGLING.test(c)) ?? "";
}
