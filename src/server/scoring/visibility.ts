/**
 * AI Visibility score (0–100). Pure and framework-free; the UI only displays it.
 *
 *   score = 100 × ( 0.35 · mentionRate
 *                 + 0.25 · positionScore
 *                 + 0.20 · shareOfVoice
 *                 + 0.10 · citationRate
 *                 + 0.10 · sentiment01 )
 *
 * over a set of AI answers (one scan, a provider, a date range...):
 *   mentionRate   = answers mentioning the brand / answers
 *   positionScore = mean over mentioning answers of 1 / (1 + 0.5·(rank − 1))
 *                   (rank 1 → 1, 2 → 0.67, 3 → 0.5, 5 → 0.33); 0 if never mentioned
 *   shareOfVoice  = brand mentions / mentions of all tracked brands (brand + competitors)
 *   citationRate  = answers citing the brand's own domain / answers
 *   sentiment01   = (mean sentiment + 1) / 2 over mentioning answers with a sentiment;
 *                   0.5 (neutral) if mentioned but unscored; 0 if never mentioned
 * Weights are configurable (VISIBILITY_WEIGHTS) and versioned on every snapshot.
 */
export interface VisibilityWeights {
  mention: number;
  position: number;
  shareOfVoice: number;
  citation: number;
  sentiment: number;
}

export const DEFAULT_WEIGHTS: VisibilityWeights = { mention: 0.35, position: 0.25, shareOfVoice: 0.2, citation: 0.1, sentiment: 0.1 };
const KEYS: Array<keyof VisibilityWeights> = ["mention", "position", "shareOfVoice", "citation", "sentiment"];

export interface ResolvedWeights {
  weights: VisibilityWeights;
  /** e.g. "w1:35-25-20-10-10" — stored with every snapshot. */
  version: string;
}

/** Normalizes weights to sum to 1. Throws on negative or all-zero weights. */
export function normalizeWeights(w: VisibilityWeights): ResolvedWeights {
  const values = KEYS.map((k) => w[k]);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("Visibility weights must be non-negative numbers");
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error("Visibility weights must not all be zero");
  const weights = Object.fromEntries(KEYS.map((k) => [k, w[k] / sum])) as unknown as VisibilityWeights;
  return { weights, version: `w1:${KEYS.map((k) => Math.round(weights[k] * 1000) / 10).join("-")}` };
}

/** VISIBILITY_WEIGHTS="mention,position,shareOfVoice,citation,sentiment", e.g. "35,25,20,10,10". */
export function resolveWeights(env: Record<string, string | undefined> = process.env): ResolvedWeights {
  const raw = env.VISIBILITY_WEIGHTS?.trim();
  if (!raw) return normalizeWeights(DEFAULT_WEIGHTS);
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== KEYS.length) throw new Error(`VISIBILITY_WEIGHTS needs ${KEYS.length} comma-separated numbers`);
  return normalizeWeights(Object.fromEntries(KEYS.map((k, i) => [k, parts[i]!])) as unknown as VisibilityWeights);
}

/** One AI answer, seen from the perspective of one brand (primary or a competitor). */
export interface ResponseObservation {
  mentioned: boolean;
  /** Rank among tracked brands in that answer (1 = first). */
  position: number | null;
  /** −1 … 1, null when unknown. */
  sentiment: number | null;
  /** The brand's own domain is among the answer's citations. */
  cited: boolean;
  /** Tracked brands (brand + competitors) mentioned in the answer. */
  trackedBrandMentions: number;
}

export interface VisibilityMetrics {
  sampleSize: number;
  mentionRate: number;
  positionScore: number;
  averagePosition: number | null;
  shareOfVoice: number;
  citationRate: number;
  /** Mean sentiment −1 … 1 over mentioning answers with a sentiment (null if none). */
  sentimentScore: number | null;
  components: VisibilityWeights;
  visibilityScore: number;
}

export const positionToScore = (rank: number) => 1 / (1 + 0.5 * (Math.max(1, rank) - 1));

const round = (n: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function computeVisibility(observations: ResponseObservation[], resolved: ResolvedWeights = normalizeWeights(DEFAULT_WEIGHTS)): VisibilityMetrics {
  const n = observations.length;
  const mentioned = observations.filter((o) => o.mentioned);
  const m = mentioned.length;
  const positions = mentioned.map((o) => o.position).filter((p): p is number => p !== null);
  const sentiments = mentioned.map((o) => o.sentiment).filter((s): s is number => s !== null);
  const totalTracked = observations.reduce((a, o) => a + o.trackedBrandMentions, 0);

  const mentionRate = n ? m / n : 0;
  const positionScore = positions.length ? mean(positions.map(positionToScore)) : 0;
  const shareOfVoice = totalTracked ? m / totalTracked : 0;
  const citationRate = n ? observations.filter((o) => o.cited).length / n : 0;
  const sentimentScore = sentiments.length ? mean(sentiments) : null;
  const sentiment01 = m === 0 ? 0 : sentimentScore === null ? 0.5 : (sentimentScore + 1) / 2;

  const components: VisibilityWeights = { mention: mentionRate, position: positionScore, shareOfVoice, citation: citationRate, sentiment: sentiment01 };
  const w = resolved.weights;
  const raw = w.mention * components.mention + w.position * components.position + w.shareOfVoice * components.shareOfVoice + w.citation * components.citation + w.sentiment * components.sentiment;

  return {
    sampleSize: n,
    mentionRate: round(mentionRate, 4),
    positionScore: round(positionScore, 4),
    averagePosition: positions.length ? round(mean(positions), 2) : null,
    shareOfVoice: round(shareOfVoice, 4),
    citationRate: round(citationRate, 4),
    sentimentScore: sentimentScore === null ? null : round(sentimentScore, 4),
    components: Object.fromEntries(Object.entries(components).map(([k, v]) => [k, round(v, 4)])) as unknown as VisibilityWeights,
    // Settle float noise first (100 × 0.5355 = 53.5499…) so half-way values round up as by hand.
    visibilityScore: round(round(100 * raw, 6), 1),
  };
}

/** "+7.4 vs previous period". Null when there is no previous value. */
export function scoreDelta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return round(current - previous, 1);
}
