/**
 * HTML → structured page content. Output is untrusted website text; callers
 * must treat it as data (it is passed to LLMs inside delimited blocks).
 */
import * as cheerio from "cheerio";

export interface JsonLdEntity {
  type: string;
  name?: string;
  description?: string;
  url?: string;
  sameAs?: string[];
}

export interface ExtractedPage {
  url: string;
  title: string;
  description: string;
  canonical?: string;
  lang?: string;
  siteName?: string;
  headings: { h1: string[]; h2: string[]; h3: string[] };
  text: string;
  wordCount: number;
  links: string[];
  jsonLd: JsonLdEntity[];
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

function parseJsonLd($: cheerio.CheerioAPI): JsonLdEntity[] {
  const out: JsonLdEntity[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj["@graph"])) (obj["@graph"] as unknown[]).forEach(visit);
    const rawType = obj["@type"];
    const type = Array.isArray(rawType) ? String(rawType[0]) : typeof rawType === "string" ? rawType : "";
    if (type) {
      const sameAs = obj.sameAs;
      out.push({
        type,
        name: typeof obj.name === "string" ? clean(obj.name) : undefined,
        description: typeof obj.description === "string" ? clean(obj.description).slice(0, 500) : undefined,
        url: typeof obj.url === "string" ? obj.url : undefined,
        sameAs: Array.isArray(sameAs) ? sameAs.filter((s): s is string => typeof s === "string").slice(0, 20) : typeof sameAs === "string" ? [sameAs] : undefined,
      });
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  return out.slice(0, 30);
}

export function extractPage(html: string, pageUrl: string, maxTextChars = 8000): ExtractedPage {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  const meta = (sel: string) => clean($(sel).attr("content"));
  const title = clean($("title").first().text()) || meta('meta[property="og:title"]');
  const description = meta('meta[name="description"]') || meta('meta[property="og:description"]');
  const canonicalHref = $('link[rel="canonical"]').attr("href");
  let canonical: string | undefined;
  try {
    canonical = canonicalHref ? new URL(canonicalHref, base).href : undefined;
  } catch {
    canonical = undefined;
  }

  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript):/i.test(href)) return;
    try {
      const u = new URL(href, base);
      u.hash = "";
      if (u.protocol === "http:" || u.protocol === "https:") links.push(u.href);
    } catch {
      /* ignore */
    }
  });

  const jsonLd = parseJsonLd($);
  const headings = {
    h1: uniq($("h1").map((_, el) => clean($(el).text())).get().filter(Boolean)).slice(0, 10),
    h2: uniq($("h2").map((_, el) => clean($(el).text())).get().filter(Boolean)).slice(0, 25),
    h3: uniq($("h3").map((_, el) => clean($(el).text())).get().filter(Boolean)).slice(0, 25),
  };

  $("script, style, noscript, template, svg, iframe, nav, footer, header, form, [aria-hidden=true]").remove();
  const root = $("main").length ? $("main") : $("body");
  const blocks = root
    .find("h1, h2, h3, h4, p, li, td, dt, dd, blockquote")
    .map((_, el) => clean($(el).text()))
    .get()
    .filter((t) => t.length > 2);
  const text = uniq(blocks).join("\n").slice(0, maxTextChars);

  return {
    url: pageUrl,
    title: title.slice(0, 300),
    description: description.slice(0, 500),
    canonical,
    lang: clean($("html").attr("lang")) || undefined,
    siteName: meta('meta[property="og:site_name"]') || undefined,
    headings,
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    links: uniq(links).slice(0, 500),
    jsonLd,
  };
}
