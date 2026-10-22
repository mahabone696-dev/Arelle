import { XMLParser } from "fast-xml-parser";

export interface SitemapParseResult {
  urls: string[];
  /** Child sitemaps when the document is a <sitemapindex>. */
  sitemaps: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // No entity expansion: prevents billion-laughs style payloads.
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => name === "url" || name === "sitemap",
});

function locs(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => (e && typeof e === "object" && "loc" in e ? String((e as { loc: unknown }).loc).trim() : ""))
    .filter((loc) => /^https?:\/\//i.test(loc));
}

export function parseSitemap(xml: string, limit = 5000): SitemapParseResult {
  try {
    const doc = parser.parse(xml) as { urlset?: { url?: unknown }; sitemapindex?: { sitemap?: unknown } };
    return {
      urls: locs(doc.urlset?.url).slice(0, limit),
      sitemaps: locs(doc.sitemapindex?.sitemap).slice(0, 50),
    };
  } catch {
    return { urls: [], sitemaps: [] };
  }
}
