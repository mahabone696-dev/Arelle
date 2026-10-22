/**
 * Deterministic brand detection in AI answers.
 *
 * Each tracked brand (primary + competitors) gets a set of surface forms:
 * its name, the name without legal suffixes, user aliases, and its domain.
 * Matching is whole-word and Unicode-aware. Names that are also ordinary
 * words ("Close", "Monday", "Notion") are matched case-sensitively, and a
 * match at the start of a sentence counts with reduced confidence, because
 * "Close the deal…" is not a mention of Close.
 */
import { escapeRegExp, splitSentences } from "./text";

export interface BrandEntity {
  key: string;
  name: string;
  aliases: string[];
  domain: string | null;
  isPrimary: boolean;
  competitorId?: string;
}

export interface BrandMatch {
  key: string;
  name: string;
  isPrimary: boolean;
  competitorId?: string;
  domain: string | null;
  /** Offset of the first occurrence in the analyzed text. */
  firstOffset: number;
  occurrences: number;
  /** 0–1: how sure we are this is the brand and not an ordinary word. */
  confidence: number;
  /** Sentences that contain the brand (for sentiment / strength / UI snippets). */
  sentences: string[];
}

const LEGAL_SUFFIX = /[,\s]+(inc|inc\.|llc|ltd|ltd\.|limited|gmbh|ag|sa|s\.a\.|sas|bv|b\.v\.|plc|corp|corp\.|corporation|co\.|oy|ab|as|srl|pty)$/i;

// Common words that are also product names. Matched case-sensitively and treated as ambiguous at sentence start.
const COMMON_WORDS = new Set(
  (
    "close copper monday notion slack zoom square stripe apple box front linear nimble pipeline insightly keep basecamp " +
    "fresh ring wave sage xero brex ramp mercury gusto rippling deel remote affinity attio folk streak loop drift " +
    "intercom help scout crisp buffer later hootsuite canva figma frame miro lucid coda quip asana trello jira clickup " +
    "harvest float forecast toggl clockify calendly cal amazon target gap shell visa chase discover capital one " +
    "mint quicken wise revolut monzo starling chime current venmo cash signal telegram line kik discord element " +
    "matrix bolt lime bird uber lyft grab via indeed glassdoor hired angel lever greenhouse workable recruitee " +
    "personio factorial hibob lattice culture amp leapsome 15five officevibe peakon glint pendo heap amplitude " +
    "mixpanel segment rudderstack fivetran airbyte stitch hightouch census dbt looker mode tableau domo sisense " +
    "hex deepnote observable retool appsmith budibase bubble webflow wix squarespace ghost medium substack beehiiv " +
    "convertkit kit mailchimp brevo klaviyo omnisend drip customer io braze iterable airship onesignal pushwoosh"
  ).split(/\s+/),
);

export function isAmbiguousName(name: string): boolean {
  const n = name.trim();
  return /^[\p{L}]+$/u.test(n) && COMMON_WORDS.has(n.toLowerCase());
}

interface Pattern {
  re: RegExp;
  ambiguous: boolean;
}

function surfaceForms(entity: BrandEntity): string[] {
  const forms = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t && t.length >= 2) forms.add(t);
  };
  add(entity.name);
  add(entity.name.replace(LEGAL_SUFFIX, ""));
  for (const a of entity.aliases) add(a);
  if (entity.domain) {
    add(entity.domain);
    add(`www.${entity.domain}`);
  }
  return [...forms];
}

function buildPatterns(entity: BrandEntity): Pattern[] {
  return surfaceForms(entity).map((form) => {
    const ambiguous = isAmbiguousName(form);
    // Whole-word boundaries; allow possessive ("HubSpot's") and a following ".com"-less form.
    const body = escapeRegExp(form).replace(/\\ /g, "\\s+").replace(/ /g, "\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}@./-])${body}(?=$|[^\\p{L}\\p{N}]|['’]s\\b)`, ambiguous ? "gu" : "giu");
    return { re, ambiguous };
  });
}

/**
 * True when an ambiguous word sits where any word would be capitalized anyway:
 * the very start of the text or right after sentence-ending punctuation.
 * Line and list-item starts ("1. Close – …", headings) are NOT ambiguous —
 * in AI answers those are almost always product names.
 */
export function isProseSentenceStart(text: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  if (i < 0) return true;
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  // "1. Close" / "2) Close": the period belongs to a list marker, not a sentence.
  if (/^\s*\d+[.)]\s*$/.test(text.slice(lineStart, offset))) return false;
  return text[i] === "." || text[i] === "!" || text[i] === "?";
}

export function matchBrands(text: string, entities: BrandEntity[]): BrandMatch[] {
  const sentences = splitSentences(text);
  const matches: BrandMatch[] = [];
  // Longer surface forms first so "HubSpot CRM" wins over "HubSpot" inside the same span.
  const claimed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => claimed.some(([a, b]) => s < b && e > a);

  const ordered = [...entities].sort((a, b) => Math.max(...surfaceForms(b).map((f) => f.length)) - Math.max(...surfaceForms(a).map((f) => f.length)));
  for (const entity of ordered) {
    let first = Infinity;
    let occurrences = 0;
    let strong = 0;
    let distinctive = false;
    const spans: Array<[number, number]> = [];
    for (const { re, ambiguous } of buildPatterns(entity)) {
      for (const m of text.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (overlaps(start, end) || spans.some(([a, b]) => start < b && end > a)) continue;
        spans.push([start, end]);
        occurrences++;
        if (!ambiguous) distinctive = true;
        if (!ambiguous || !isProseSentenceStart(text, start)) strong++;
        first = Math.min(first, start);
      }
    }
    if (!occurrences) continue;
    claimed.push(...spans);
    // Confidence depends on the forms that actually matched: a distinctive form (name, domain) is
    // near-certain; an ambiguous word mid-sentence or in a list is likely; only at prose starts, unlikely.
    const confidence = distinctive ? 0.95 : strong > 0 ? 0.85 : 0.4;
    matches.push({
      key: entity.key,
      name: entity.name,
      isPrimary: entity.isPrimary,
      competitorId: entity.competitorId,
      domain: entity.domain,
      firstOffset: first,
      occurrences,
      confidence,
      sentences: sentences.filter((s) => spans.some(([a]) => a >= s.start && a < s.end)).map((s) => s.text),
    });
  }
  return matches.sort((a, b) => a.firstOffset - b.firstOffset);
}

/** Minimum confidence for a match to count as a mention in metrics. */
export const MENTION_CONFIDENCE_THRESHOLD = 0.5;
