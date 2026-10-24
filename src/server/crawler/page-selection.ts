/**
 * Picks the most informative same-site pages for brand understanding.
 * Deterministic: same inputs → same selection.
 */
import { isSameSite } from "./url-policy";

const BOOST: Array<[RegExp, number]> = [
  [/\/(about|about-us|company|who-we-are)(\/|$)/, 40],
  [/\/(products?|platform|features?|solutions?|services?)(\/|$)/, 35],
  [/\/(pricing|plans)(\/|$)/, 30],
  [/\/(customers?|case-studies|industries|use-cases?)(\/|$)/, 20],
  [/\/(compare|vs|versus|alternatives?|why-)/, 20],
  [/\/(integrations?|apps?|marketplace)(\/|$)/, 10],
];

const EXCLUDE = [
  /\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|logout|password)(\/|$)/,
  /\/(privacy|terms|legal|cookies?|gdpr|imprint|impressum|disclaimer|sitemap)(\/|$|[-.])/,
  /\/(tag|tags|category|categories|author|page)\//,
  /\/(wp-admin|wp-json|cdn-cgi|_next|static|assets)\//,
  /\.(pdf|jpe?g|png|gif|svg|webp|mp4|mp3|zip|xml|json|css|js|ico|txt|docx?|xlsx?)$/,
];

const LOW = [/\/(blog|news|press|careers|jobs|events|webinars?|podcast|docs|help|support|status)(\/|$)/];

// Two-letter path prefixes that are language codes on localized sites (/de/, /pt-br/).
const LOCALE_CODES = new Set("en de fr es pt it nl sv no nb da fi pl cs sk sl hr hu ro bg el ru uk tr ar he hi id th vi ja ko zh et lv lt".split(" "));
const LOCALE_PREFIX = /^\/([a-z]{2})(?:[-_][a-z]{2,4})?(?=\/|$)/;

/** Splits "/de-at/pricing" into { locale: "de", rest: "/pricing" } when the prefix is a language code. */
export function splitLocale(pathname: string): { locale?: string; rest: string } {
  const m = LOCALE_PREFIX.exec(pathname.toLowerCase());
  if (m && LOCALE_CODES.has(m[1]!)) return { locale: m[1], rest: pathname.slice(m[0].length) || "/" };
  return { rest: pathname };
}

export function scoreUrl(url: URL, language?: string): number {
  const { locale, rest } = splitLocale(url.pathname);
  const path = rest.toLowerCase();
  if (EXCLUDE.some((r) => r.test(path))) return -1;
  let score = 10;
  // Strongest matching signal only: stacking keywords would favour deep, narrow pages.
  score += Math.max(0, ...BOOST.filter(([re]) => re.test(path)).map(([, boost]) => boost));
  if (LOW.some((r) => r.test(path))) score -= 15;
  const depth = path.split("/").filter(Boolean).length;
  score -= depth * 4;
  if (url.search) score -= 10;
  // Translations in other languages add no information about the brand and skew extraction.
  if (locale && locale !== language) score -= 40;
  return score;
}

const MAX_PER_SECTION = 3;

export function selectPages(candidates: string[], site: string, homepage: string, limit: number, language?: string): string[] {
  const seen = new Set<string>([normalize(homepage)]);
  const scored: Array<{ url: string; score: number; section: string; dedupeKey: string }> = [];
  for (const raw of candidates) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !isSameSite(u, site)) continue;
    u.hash = "";
    const key = normalize(u.href);
    if (seen.has(key)) continue;
    seen.add(key);
    const score = scoreUrl(u, language);
    if (score > 0) scored.push({ url: u.href, score, section: sectionOf(u), dedupeKey: localeFreeKey(u) });
  }
  scored.sort((a, b) => b.score - a.score || a.url.length - b.url.length || a.url.localeCompare(b.url));

  // Diversity: at most N pages per top-level section, and one page per locale-free path (/en/about ≡ /about).
  const perSection = new Map<string, number>();
  const pathsTaken = new Set<string>([localeFreeKey(new URL(homepage))]);
  const picked: string[] = [];
  for (const c of scored) {
    if (picked.length >= limit) break;
    const n = perSection.get(c.section) ?? 0;
    if (n >= MAX_PER_SECTION || pathsTaken.has(c.dedupeKey)) continue;
    perSection.set(c.section, n + 1);
    pathsTaken.add(c.dedupeKey);
    picked.push(c.url);
  }
  return picked;
}

function sectionOf(u: URL): string {
  return splitLocale(u.pathname).rest.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
}

function localeFreeKey(u: URL): string {
  return `${u.hostname.replace(/^www\./, "")}${splitLocale(u.pathname).rest.replace(/\/+$/, "") || "/"}`;
}

function normalize(href: string): string {
  const u = new URL(href);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "") || "/"}${u.search}`;
}
