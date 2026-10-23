/**
 * Matching prompts to pages on the user's site (from the onboarding crawl's
 * page summaries). Heuristic and deterministic: a page targets a prompt when it
 * covers the prompt's distinctive terms in its URL, title or H1.
 */
export interface SitePage {
  url: string;
  title: string | null;
  description?: string | null;
  h1?: string[];
}

const STOPWORDS = new Set(
  "a an and are as at be best better can compare comparison do does for from get good great how i in is it its me my of on or our the their them to top tool tools vs versus what which who why with without you your alternative alternatives option options software platform app apps solution solutions review reviews 2024 2025 2026 cheap cheaper cheapest affordable free".split(" "),
);

export const tokenize = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);

const stem = (t: string) => (t.length > 4 && t.endsWith("ies") ? `${t.slice(0, -3)}y` : t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

function pageTerms(p: SitePage): Set<string> {
  let path = "";
  try {
    path = decodeURIComponent(new URL(p.url).pathname);
  } catch {
    path = p.url;
  }
  return new Set(tokenize(`${path} ${p.title ?? ""} ${(p.h1 ?? []).join(" ")}`).map(stem));
}

const isHome = (p: SitePage) => {
  try {
    return new URL(p.url).pathname.replace(/\/+$/, "") === "";
  } catch {
    return false;
  }
};

/**
 * Best page for a prompt, or null when none targets it.
 * Terms that appear on most pages (the category, e.g. "crm") don't count as
 * distinctive; a prompt with no distinctive terms ("best CRM software") is
 * served by the homepage.
 */
export function matchPage(prompt: string, pages: SitePage[], entityNames: string[] = []): SitePage | null {
  if (!pages.length) return null;
  const termsByPage = pages.map(pageTerms);
  const common = new Set<string>();
  const counts = new Map<string, number>();
  for (const terms of termsByPage) for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [t, n] of counts) if (pages.length >= 3 && n / pages.length > 0.5) common.add(t);
  const entityTerms = new Set(entityNames.flatMap((n) => tokenize(n)).map(stem));
  const terms = [...new Set(tokenize(prompt).map(stem))].filter((t) => !STOPWORDS.has(t) && !common.has(t) && !(entityTerms.has(t) && !prompt.toLowerCase().includes(" vs ") && !/alternativ/i.test(prompt)));
  if (!terms.length) return pages.find(isHome) ?? null;
  let best: { page: SitePage; score: number } | null = null;
  pages.forEach((page, i) => {
    const hit = terms.filter((t) => termsByPage[i]!.has(t)).length / terms.length;
    if (!best || hit > best.score) best = { page, score: hit };
  });
  const b = best as { page: SitePage; score: number } | null;
  return b && b.score >= 0.6 ? b.page : null;
}
