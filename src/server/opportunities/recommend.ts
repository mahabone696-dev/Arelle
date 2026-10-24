/**
 * Action engine: turns each opportunity into concrete recommendations —
 * WHAT (title), WHY (reason, from the evidence), WHERE (target URL),
 * HOW (steps) and EXPECTED IMPACT (LOW/MEDIUM/HIGH).
 *
 * Deterministic templates. Wording describes what was observed and what to
 * try; it never promises ranking or visibility gains.
 */
import type { ImpactLevel, RecommendationType } from "@/generated/prisma/enums";
import {
  competitorsInPrompt,
  type EngineCompetitor,
  type EnginePrompt,
  type OpportunityDraft,
} from "./rules";
import { tokenize } from "./pages";

export interface RecommendationDraft {
  type: RecommendationType;
  title: string;
  /** WHY */
  reason: string;
  /** WHERE */
  targetUrl: string | null;
  /** HOW — one step per line. */
  suggestedAction: string;
  estimatedImpact: ImpactLevel;
}

export interface RecommendContext {
  brand: { name: string; domain: string; industry?: string | null };
  competitors: EngineCompetitor[];
  prompt?: EnginePrompt | null;
}

export function impactLevel(score: number): ImpactLevel {
  return score >= 65 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW";
}
const lower = (l: ImpactLevel): ImpactLevel => (l === "HIGH" ? "MEDIUM" : "LOW");

const SLUG_DROP = new Set([
  "best",
  "top",
  "the",
  "a",
  "an",
  "what",
  "which",
  "is",
  "are",
  "most",
  "good",
  "great",
  "recommended",
  "2024",
  "2025",
  "2026",
]);
export function slugFor(text: string, keepAll = false): string {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return (
    (keepAll ? words : words.filter((w) => !SLUG_DROP.has(w)))
      .join("-")
      .slice(0, 70)
      .replace(/-+$/, "") || "page"
  );
}
const slug = (s: string) => tokenize(s).join("-");

function siteUrl(domain: string, path: string) {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

const steps = (...lines: (string | false | null | undefined)[]) => lines.filter(Boolean).join("\n");
const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
const pct = (a: number, b: number) => `${Math.round((100 * a) / Math.max(1, b))}%`;

const REVIEW_SITES = [
  "g2.com",
  "capterra.com",
  "trustradius.com",
  "getapp.com",
  "softwareadvice.com",
  "trustpilot.com",
  "producthunt.com",
  "gartner.com",
  "sourceforge.net",
  "saasworthy.com",
  "clutch.co",
];
const COMMUNITIES = [
  "reddit.com",
  "quora.com",
  "ycombinator.com",
  "stackexchange.com",
  "stackoverflow.com",
  "indiehackers.com",
  "community.",
  "forum.",
];
const VIDEO = ["youtube.com", "vimeo.com", "tiktok.com"];
const ENCYCLOPEDIA = ["wikipedia.org", "wikidata.org"];
type SourceKind = "REVIEW" | "COMMUNITY" | "VIDEO" | "ENCYCLOPEDIA" | "EDITORIAL";
export function sourceKind(domain: string): SourceKind {
  const has = (xs: string[]) =>
    xs.some((x) =>
      x.endsWith(".") ? domain.startsWith(x) : domain === x || domain.endsWith(`.${x}`),
    );
  if (has(REVIEW_SITES)) return "REVIEW";
  if (has(COMMUNITIES)) return "COMMUNITY";
  if (has(VIDEO)) return "VIDEO";
  if (has(ENCYCLOPEDIA)) return "ENCYCLOPEDIA";
  return "EDITORIAL";
}

function category(ctx: RecommendContext) {
  return ctx.brand.industry?.trim() || "solution";
}

function lostPrompt(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  const e = o.evidence;
  const prompt = ctx.prompt!;
  const brand = ctx.brand.name;
  const level = impactLevel(o.impactScore);
  const shown = (e.competitors ?? []).slice(0, 3).map((c) => c.name);
  const absent = e.answers - (e.yourMentions ?? 0);
  const why =
    o.type === "CONTENT_GAP"
      ? o.description
      : `${brand} is absent from ${pct(absent, e.answers)} of AI answers for “${prompt.text}” (${absent} of ${e.answers})` +
        (shown.length
          ? `, while ${list(shown)} ${shown.length === 1 ? "is" : "are"} mentioned.`
          : ".") +
        (e.sources?.length ? ` Those answers cite ${list(e.sources.map((s) => s.domain))}.` : "");
  const named = competitorsInPrompt(prompt.text, ctx.competitors);
  const others = shown.filter((n) => !named.some((c) => c.name === n));
  const sourcesStep = e.sources?.length
    ? `Get ${brand} represented on the sources these answers cite (${list(e.sources.map((s) => s.domain))}) — see the citation recommendations.`
    : null;
  const recs: RecommendationDraft[] = [];

  if (e.page && prompt.intent !== "BRANDED") {
    recs.push({
      type: "UPDATE_CONTENT",
      title: `Update ${pathOf(e.page.url)} to answer “${prompt.text}”`,
      reason: `${why} Your page ${e.page.url} is the closest match on your site but isn't being surfaced.`,
      targetUrl: e.page.url,
      suggestedAction: steps(
        `Answer the question in the first paragraph: who ${brand} is for and why it fits “${prompt.text}”.`,
        `Use the words people use in the prompt in the title, H1 and a subheading.`,
        `Add specifics AI answers can quote: pricing, key features, integrations, customer examples with numbers.`,
        shown.length > 0 &&
          `Add an honest comparison with ${list(shown)}: where each one fits best.`,
        `Add an FAQ section covering the follow-up questions buyers ask.`,
        sourcesStep,
      ),
      estimatedImpact: level,
    });
    recs.push(faq(prompt, e.page.url, brand, lower(level)));
    return recs;
  }

  switch (prompt.intent) {
    case "COMPARISON": {
      const vs =
        named[0] ??
        (e.competitors?.[0]
          ? ctx.competitors.find((c) => c.id === e.competitors![0]!.id)
          : undefined);
      const path = `/compare/${slug(brand)}-vs-${slug(vs?.name ?? "alternatives")}`;
      recs.push({
        type: "CREATE_COMPARISON_PAGE",
        title: vs
          ? `Create a “${brand} vs ${vs.name}” comparison page`
          : `Create a comparison page for “${prompt.text}”`,
        reason: why,
        targetUrl: siteUrl(ctx.brand.domain, path),
        suggestedAction: steps(
          `Compare ${brand} with ${list(named.length ? named.map((c) => c.name) : vs ? [vs.name] : shown)} side by side: features, pricing, integrations, support, ideal customer.`,
          `Be factual and fair — state where a competitor is the better fit. Balanced pages are more likely to be cited.`,
          `Put a short summary table at the top and a clear “who should choose which” section.`,
          `Date the page and keep pricing current.`,
          `Link to it from your pricing and product pages.`,
          sourcesStep,
        ),
        estimatedImpact: level,
      });
      break;
    }
    case "ALTERNATIVE": {
      const of = named[0];
      const path = of ? `/alternatives/${slug(of.name)}` : `/${slugFor(prompt.text)}`;
      recs.push({
        type: "CREATE_COMPARISON_PAGE",
        title: of
          ? `Create a “${of.name} alternatives” page featuring ${brand}`
          : `Create a page for “${prompt.text}”`,
        reason: why,
        targetUrl: siteUrl(ctx.brand.domain, path),
        suggestedAction: steps(
          of
            ? `Explain why teams look for ${of.name} alternatives (price, complexity, missing features) and how ${brand} addresses each.`
            : `Explain the main reasons buyers switch, and how ${brand} addresses each.`,
          `List ${brand} alongside other credible options${others.length ? ` such as ${list(others)}` : ""}, with honest pros and cons.`,
          of &&
            `Add a migration section: importing data from ${of.name}, timelines, and support offered.`,
          `Include a comparison table and an FAQ.`,
          sourcesStep,
        ),
        estimatedImpact: level,
      });
      break;
    }
    case "BRANDED": {
      recs.push({
        type: "IMPROVE_ENTITY_CLARITY",
        title: `Make it clear what ${brand} is and who it's for`,
        reason: `${why} For a prompt about ${brand} itself, this suggests AI engines aren't confident about the brand.`,
        targetUrl: siteUrl(ctx.brand.domain, "/about"),
        suggestedAction: steps(
          `State in one sentence on the homepage and About page: “${brand} is a ${category(ctx)} for …”. Use the same wording everywhere.`,
          `Use one consistent brand name across your site, social profiles and directory listings.`,
          `Publish verifiable facts: founding year, location, team, customers, pricing.`,
          `Make sure third-party profiles (review sites, Crunchbase, LinkedIn) describe ${brand} the same way.`,
        ),
        estimatedImpact: level,
      });
      recs.push({
        type: "ADD_SCHEMA",
        title: `Add Organization and Product structured data`,
        reason: `Structured data states plainly who ${brand} is and what it offers, which helps search and AI systems identify the brand.`,
        targetUrl: siteUrl(ctx.brand.domain, "/"),
        suggestedAction: steps(
          `Add Organization schema (name, url, logo, sameAs links to your official profiles) to the homepage.`,
          `Add Product or SoftwareApplication schema with description, category and offers on product/pricing pages.`,
          `Validate with Google's Rich Results Test and fix any warnings.`,
        ),
        estimatedImpact: lower(level),
      });
      return recs;
    }
    case "INFORMATIONAL": {
      recs.push({
        type: "CREATE_CONTENT",
        title: `Publish a guide answering “${prompt.text}”`,
        reason: why,
        targetUrl: siteUrl(ctx.brand.domain, `/blog/${slugFor(prompt.text, true)}`),
        suggestedAction: steps(
          `Answer the question directly in the first two sentences, then go deeper with steps, examples and data.`,
          `Show where ${brand} fits naturally (one section, not a sales pitch).`,
          `Add original material AI answers can cite: a checklist, a template, survey numbers or a worked example.`,
          `Add an FAQ and an author with relevant expertise.`,
          sourcesStep,
        ),
        estimatedImpact: lower(level),
      });
      recs.push({
        type: "INTERNAL_LINKING",
        title: `Link the guide to your product pages`,
        reason: `Informational answers that mention a product usually link it to a page that explains it; connect the guide to the relevant ${brand} pages.`,
        targetUrl: siteUrl(ctx.brand.domain, `/blog/${slugFor(prompt.text, true)}`),
        suggestedAction: steps(
          `Link from the guide to the most relevant product or feature page with descriptive anchor text.`,
          `Link back to the guide from related posts and the product page.`,
        ),
        estimatedImpact: "LOW",
      });
      return recs;
    }
    default: {
      // COMMERCIAL / TRANSACTIONAL with no page on the site.
      recs.push({
        type: "CREATE_LANDING_PAGE",
        title: `Create a “${focusPhrase(prompt.text)}” landing page`,
        reason:
          o.type === "CONTENT_GAP"
            ? why
            : `${why} No page on ${ctx.brand.domain} targets this prompt.`,
        targetUrl: siteUrl(ctx.brand.domain, `/${slugFor(prompt.text)}`),
        suggestedAction: steps(
          `Create a dedicated page for this need. Open with who it's for and why ${brand} fits.`,
          `Cover the workflows, key features, integrations and pricing relevant to this audience.`,
          `Add proof: customer examples, numbers, reviews.`,
          shown.length > 0 && `Include an honest comparison with ${list(shown)}.`,
          `Add an FAQ with FAQPage structured data.`,
          `Link to the page from your homepage navigation or a relevant hub page.`,
          sourcesStep,
        ),
        estimatedImpact: level,
      });
      recs.push(
        faq(prompt, siteUrl(ctx.brand.domain, `/${slugFor(prompt.text)}`), brand, lower(level)),
      );
    }
  }
  return recs;
}

function faq(
  prompt: EnginePrompt,
  url: string,
  brand: string,
  impact: ImpactLevel,
): RecommendationDraft {
  return {
    type: "ADD_FAQ",
    title: `Add an FAQ for “${prompt.text}”`,
    reason: `AI answers often reuse short, direct question-and-answer passages. An FAQ gives them clear statements about ${brand} to draw on.`,
    targetUrl: url,
    suggestedAction: steps(
      `Add 5–8 questions buyers ask about this topic (pricing, setup time, integrations, who it's for, how it compares).`,
      `Answer each in 2–3 factual sentences that name ${brand}.`,
      `Mark it up with FAQPage structured data.`,
    ),
    estimatedImpact: impact,
  };
}

function positionGap(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  const e = o.evidence;
  const brand = ctx.brand.name;
  const prompt = ctx.prompt!;
  const target = e.page?.url ?? siteUrl(ctx.brand.domain, "/");
  const rival = e.outrankedBy?.name ?? "competitors";
  return [
    {
      type: "UPDATE_CONTENT",
      title: `Sharpen ${brand}'s positioning for “${prompt.text}”`,
      reason: `${brand} is mentioned, but at an average position of ${e.averagePosition?.toFixed(1)}; ${rival} is listed above it in ${e.outrankedBy?.answers ?? 0} answers.`,
      targetUrl: target,
      suggestedAction: steps(
        `Lead with one clear sentence on what ${brand} is best at for this use case.`,
        `Back it with specifics: measurable results, notable customers, awards, review ratings.`,
        `Explain differences from ${rival} plainly — where ${brand} is the stronger choice and for whom.`,
        `Keep facts consistent between your site and third-party profiles.`,
      ),
      estimatedImpact: impactLevel(o.impactScore),
    },
    {
      type: "INTERNAL_LINKING",
      title: `Strengthen internal links to ${pathOf(target)}`,
      reason: `Pages that are well linked within a site are easier to find and understand as the main page for a topic.`,
      targetUrl: target,
      suggestedAction: steps(
        `Link to this page from the homepage, related product pages and recent posts using descriptive anchor text.`,
        `Remove or merge thin pages that compete for the same topic.`,
      ),
      estimatedImpact: "LOW",
    },
  ];
}

/** A content gap gets the same page templates as a lost prompt (comparison, alternatives or landing page). */
function contentGap(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  return lostPrompt(o, ctx);
}

function dominance(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  const e = o.evidence;
  const brand = ctx.brand.name;
  const rival = e.leader!.name;
  const level = impactLevel(o.impactScore);
  const recs: RecommendationDraft[] = [
    {
      type: "CREATE_COMPARISON_PAGE",
      title: `Create a “${brand} vs ${rival}” comparison page`,
      reason: `${rival} appears in ${Math.round((e.competitorRate ?? 0) * 100)}% of answers to your ${o.title.replace(/^.* dominates /, "")}; ${brand} in ${Math.round((e.yourRate ?? 0) * 100)}%.`,
      targetUrl: siteUrl(ctx.brand.domain, `/compare/${slug(brand)}-vs-${slug(rival)}`),
      suggestedAction: steps(
        `Compare ${brand} and ${rival} on features, pricing, ease of setup, integrations and support.`,
        `Be specific and fair about where ${rival} is the better fit — balanced comparisons are more credible.`,
        `Add a summary table, a “who should choose which” section and an FAQ.`,
      ),
      estimatedImpact: level,
    },
  ];
  // Only editorial roundups can be pitched; review sites and communities have their own recommendations.
  const editorial = (e.sources ?? []).filter((x) => sourceKind(x.domain) === "EDITORIAL");
  if (editorial.length) {
    recs.push({
      type: "DIGITAL_PR",
      title: `Get ${brand} into the roundups that feature ${rival}`,
      reason: `Answers that mention ${rival} but not ${brand} cite ${list(editorial.map((s) => s.domain))}.`,
      targetUrl: editorial[0]!.url,
      suggestedAction: steps(
        `Contact the authors or editors of these pages: ${editorial.map((s) => s.url).join(", ")}.`,
        `Offer something useful for an update: a product demo, customer data, an expert quote or a free trial for testing.`,
        `Track which pages add ${brand} and keep the relationship for future updates.`,
      ),
      estimatedImpact: lower(level),
    });
  }
  return recs;
}

function citationGap(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  const e = o.evidence;
  const brand = ctx.brand.name;
  const domain = e.domain!;
  const url = e.sources?.[0]?.url ?? `https://${domain}/`;
  const rivals = (e.competitors ?? []).slice(0, 3).map((c) => c.name);
  const why = `${domain} is cited in ${e.answers} AI answers about your prompts; ${e.withCompetitor} of them mention ${rivals.length ? list(rivals) : "competitors"}, only ${e.withPrimary} mention ${brand}.`;
  const level = impactLevel(o.impactScore);
  switch (sourceKind(domain)) {
    case "REVIEW":
      return [
        {
          type: "CITATION_OUTREACH",
          title: `Build ${brand}'s presence on ${domain}`,
          reason: why,
          targetUrl: url,
          suggestedAction: steps(
            `Claim or create ${brand}'s profile on ${domain} and complete every field (category, pricing, features, screenshots).`,
            `Ask satisfied customers for honest reviews — never offer incentives the site's rules forbid.`,
            `Make sure ${brand} is listed in the same category as ${rivals.length ? list(rivals) : "the competitors cited"}.`,
            `Keep pricing and feature information current.`,
          ),
          estimatedImpact: level,
        },
      ];
    case "COMMUNITY":
      return [
        {
          type: "CITATION_OUTREACH",
          title: `Take part in the ${domain} discussions AI engines cite`,
          reason: why,
          targetUrl: url,
          suggestedAction: steps(
            `Read the threads being cited (starting with ${url}) to see what people ask and which tools they recommend.`,
            `Answer genuinely helpful questions where ${brand} is relevant, and always disclose that you work for ${brand}.`,
            `Encourage existing customers to share honest experiences — don't post fake or coordinated reviews.`,
          ),
          estimatedImpact: lower(level),
        },
      ];
    case "VIDEO":
      return [
        {
          type: "CREATE_CONTENT",
          title: `Publish video content on ${domain}`,
          reason: why,
          targetUrl: url,
          suggestedAction: steps(
            `Publish walkthroughs and comparison videos that answer your key prompts.`,
            `Use clear titles and descriptions naming ${brand} and the use case; add chapters and transcripts.`,
          ),
          estimatedImpact: lower(level),
        },
      ];
    case "ENCYCLOPEDIA":
      return [
        {
          type: "IMPROVE_ENTITY_CLARITY",
          title: `Make ${brand}'s facts verifiable for ${domain}`,
          reason: why,
          targetUrl: url,
          suggestedAction: steps(
            `Encyclopedias only reflect independent, reliable coverage — focus on earning press coverage rather than editing pages yourself.`,
            `Publish verifiable company facts on your site (founding, leadership, funding, customers) so editors can cite them.`,
            `Follow the site's conflict-of-interest rules if you suggest corrections.`,
          ),
          estimatedImpact: "LOW",
        },
      ];
    default:
      return [
        {
          type: "DIGITAL_PR",
          title: `Pitch ${brand} to ${domain}`,
          reason: why,
          targetUrl: url,
          suggestedAction: steps(
            `Start with the most-cited article: ${url}. Find the author and when it was last updated.`,
            `Offer what makes an update worthwhile: a demo account, customer results, original data or an expert comment.`,
            `Explain briefly where ${brand} fits compared with ${rivals.length ? list(rivals) : "the tools already listed"}.`,
            `Look for similar roundups on ${domain} and offer the same.`,
          ),
          estimatedImpact: level,
        },
      ];
  }
}

function pathOf(url: string) {
  try {
    const p = new URL(url).pathname;
    return p === "/" ? "your homepage" : p;
  } catch {
    return url;
  }
}

/** The prompt without leading filler words, original casing kept: "Best CRM for startups" → "CRM for startups". */
export function focusPhrase(text: string) {
  const words = text
    .trim()
    .replace(/[?!.]+$/, "")
    .split(/\s+/);
  while (words.length > 1 && SLUG_DROP.has(words[0]!.toLowerCase())) words.shift();
  const phrase = words.join(" ");
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Recommendations for one opportunity, most important first. */
export function recommend(o: OpportunityDraft, ctx: RecommendContext): RecommendationDraft[] {
  switch (o.type) {
    case "LOST_PROMPT":
      return lostPrompt(o, ctx);
    case "POSITION_GAP":
      return positionGap(o, ctx);
    case "CONTENT_GAP":
      return contentGap(o, ctx);
    case "COMPETITOR_DOMINANCE":
      return dominance(o, ctx);
    case "CITATION_GAP":
      return citationGap(o, ctx);
  }
}
