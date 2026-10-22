/**
 * Deterministic, lexicon-based sentiment towards a brand (English).
 * Scope: only the clause(s) that mention the brand, so "HubSpot is great but
 * Pipedrive is expensive" scores each brand separately. Negators within three
 * tokens flip a term ("not expensive", "isn't intuitive").
 * Returns -1 (negative) … 1 (positive); 0 when no opinion words are present.
 */
import { escapeRegExp, tokenize } from "./text";

export const DETERMINISTIC_SENTIMENT_LANGUAGES = new Set(["en"]);

const POSITIVE_PHRASES = ["easy to use", "best for", "best overall", "top pick", "top choice", "stands out", "highly rated", "well suited", "great value", "good value", "user friendly", "user-friendly", "highly recommend", "excellent choice", "strong choice", "market leader", "industry leader"];
const NEGATIVE_PHRASES = ["steep learning curve", "hard to use", "difficult to use", "not ideal", "can be expensive", "gets expensive", "lacks", "falls short", "limited features", "poor support", "hidden fees", "less intuitive", "not recommended", "less suitable"];

const POSITIVE = new Set(
  "best great excellent leading popular recommended powerful easy intuitive robust affordable reliable strong ideal standout favorite favourite praised flexible comprehensive scalable seamless simple fast versatile trusted innovative efficient effective solid generous impressive outstanding superior loved polished clean modern helpful responsive feature-rich budget-friendly".split(" "),
);
const NEGATIVE = new Set(
  "expensive complex complicated limited difficult poor slow outdated clunky buggy issues drawbacks cons overpriced frustrating confusing unreliable lacking weak cumbersome dated rigid costly pricey restrictive steep basic glitchy worse worst negative complaints problems downside downsides overwhelming".split(" "),
);
const NEGATORS = new Set(["not", "no", "never", "isn't", "isn’t", "aren't", "doesn't", "doesn’t", "don't", "without", "hardly", "less"]);

/** Clauses of a sentence that mention one of `names` (falls back to the whole sentence). */
export function clausesMentioning(sentence: string, names: string[]): string[] {
  // Only contrastive boundaries separate opinions; commas and dashes usually continue the same one.
  const clauses = sentence.split(/\s*(?:;|\bbut\b|\bwhile\b|\bwhereas\b|\bhowever\b|\balthough\b|\bthough\b|\bunlike\b)\s*/i).filter(Boolean);
  const re = new RegExp(names.map(escapeRegExp).join("|"), "i");
  const hit: string[] = [];
  clauses.forEach((c, i) => {
    if (re.test(c)) hit.push(c);
    // "X is fast, though it is pricey": a pronoun-led contrast clause refers back to the brand before it.
    else if (i > 0 && re.test(clauses[i - 1]!) && /^(it|its|it['’]s|they|their|this|that)\b/i.test(c)) hit.push(c);
  });
  return hit.length ? hit : [sentence];
}

export function scoreText(text: string): { positive: number; negative: number } {
  let lower = ` ${text.toLowerCase()} `;
  let positive = 0;
  let negative = 0;
  for (const p of NEGATIVE_PHRASES) if (lower.includes(p)) {
    negative++;
    lower = lower.replaceAll(p, " ");
  }
  for (const p of POSITIVE_PHRASES) if (lower.includes(p)) {
    // "not easy to use" → negative
    const negated = new RegExp(`\\b(?:not|isn['’]t|never)\\s+(?:\\w+\\s+)?${escapeRegExp(p)}`).test(lower);
    if (negated) negative++;
    else positive++;
    lower = lower.replaceAll(p, " ");
  }
  const tokens = tokenize(lower);
  tokens.forEach((t, i) => {
    const isPos = POSITIVE.has(t);
    const isNeg = NEGATIVE.has(t);
    if (!isPos && !isNeg) return;
    const negated = tokens.slice(Math.max(0, i - 3), i).some((w) => NEGATORS.has(w));
    if (isPos !== negated) positive++;
    else negative++;
  });
  return { positive, negative };
}

/** Sentiment of the given sentences towards a brand known by `names`. Null = language not supported. */
export function brandSentiment(sentences: string[], names: string[], language: string): number | null {
  if (!DETERMINISTIC_SENTIMENT_LANGUAGES.has(language)) return null;
  let positive = 0;
  let negative = 0;
  for (const s of sentences) {
    for (const clause of clausesMentioning(s, names)) {
      const r = scoreText(clause);
      positive += r.positive;
      negative += r.negative;
    }
  }
  // Damped ratio: one opinion word → ±0.5, many consistent ones → approach ±1.
  return round2((positive - negative) / (positive + negative + 1));
}

const STRONG_RECOMMENDATION = ["best overall", "top pick", "top choice", "we recommend", "i recommend", "highly recommend", "best choice", "number one", "#1", "stands out", "go-to", "market leader", "industry leader", "best option"];
const WEAK_RECOMMENDATION = ["also", "alternatively", "another option", "honorable mention", "honourable mention", "worth considering", "you could also", "other options", "niche", "if you need"];

/**
 * How strongly the answer recommends the brand (0–1):
 * 50% rank among mentioned brands (1/position), 30% recommendation phrasing,
 * 20% sentiment. A brand listed first, called "the best overall" and praised → ≈1.
 */
export function recommendationStrength(position: number, sentences: string[], sentiment: number | null): number {
  const text = sentences.join(" ").toLowerCase();
  const strong = STRONG_RECOMMENDATION.filter((p) => text.includes(p)).length;
  const weak = WEAK_RECOMMENDATION.filter((p) => new RegExp(`\\b${escapeRegExp(p)}\\b`).test(text)).length;
  // Capped so overlapping phrases ("you could also" ⊃ "also") don't double count.
  const phrase = clamp01(0.5 + 0.25 * Math.min(strong, 2) - 0.15 * Math.min(weak, 1));
  const sentiment01 = sentiment === null ? 0.5 : (sentiment + 1) / 2;
  return round2(clamp01(0.5 * (1 / position) + 0.3 * phrase + 0.2 * sentiment01));
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round2 = (n: number) => Math.round(n * 100) / 100;
