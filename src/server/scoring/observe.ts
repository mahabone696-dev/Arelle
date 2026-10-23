/** Pure: one analyzed answer seen from one brand's point of view. */
import type { ResponseObservation } from "./visibility";

export interface AnalyzedAnswer {
  providerId: string;
  country: string;
  language: string;
  brandsMentionedCount: number;
  mentions: Array<{ isPrimaryBrand: boolean; competitorId: string | null; position: number; sentiment: number | null }>;
  citations: Array<{ ownerType: string; competitorId: string | null }>;
}

/** Observation of one answer from one subject's point of view (null competitorId = primary brand). */
export function observe(answer: AnalyzedAnswer, competitorId: string | null): ResponseObservation {
  const m = answer.mentions.find((x) => (competitorId ? x.competitorId === competitorId : x.isPrimaryBrand));
  const cited = answer.citations.some((c) => (competitorId ? c.ownerType === "COMPETITOR" && c.competitorId === competitorId : c.ownerType === "PRIMARY"));
  return { mentioned: !!m, position: m?.position ?? null, sentiment: m?.sentiment ?? null, cited, trackedBrandMentions: answer.brandsMentionedCount };
}
