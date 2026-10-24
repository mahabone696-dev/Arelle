import { Badge } from "@/components/ui/badge";
import type { ImpactLevel, OpportunityType, RecommendationStatus, RecommendationType } from "@/generated/prisma/enums";

export const OPPORTUNITY_LABELS: Record<OpportunityType, string> = {
  LOST_PROMPT: "Lost prompt",
  COMPETITOR_DOMINANCE: "Competitor dominance",
  CITATION_GAP: "Citation gap",
  POSITION_GAP: "Position gap",
  CONTENT_GAP: "Content gap",
};

export const RECOMMENDATION_LABELS: Record<RecommendationType, string> = {
  CREATE_CONTENT: "Create content",
  UPDATE_CONTENT: "Update content",
  CREATE_COMPARISON_PAGE: "Comparison page",
  CREATE_LANDING_PAGE: "Landing page",
  ADD_FAQ: "Add FAQ",
  ADD_SCHEMA: "Structured data",
  IMPROVE_ENTITY_CLARITY: "Entity clarity",
  CITATION_OUTREACH: "Citation outreach",
  DIGITAL_PR: "Digital PR",
  INTERNAL_LINKING: "Internal linking",
};

const IMPACT: Record<ImpactLevel, "destructive" | "warning" | "outline"> = { HIGH: "destructive", MEDIUM: "warning", LOW: "outline" };
export const levelFor = (score: number): ImpactLevel => (score >= 65 ? "HIGH" : score >= 40 ? "MEDIUM" : "LOW");

/** Priority, not a forecast: the score orders work by how much evidence and value is at stake. */
export function ImpactBadge({ level, score }: { level?: ImpactLevel; score?: number }) {
  const l = level ?? levelFor(score ?? 0);
  return (
    <Badge variant={IMPACT[l]} title={score !== undefined ? `Impact score ${Math.round(score)}/100 — a priority signal, not a forecast` : "Expected impact — not guaranteed"}>
      {l === "MEDIUM" ? "Medium" : l === "HIGH" ? "High" : "Low"}
      {score !== undefined ? <span className="tabular ml-1 opacity-80">{Math.round(score)}</span> : null}
    </Badge>
  );
}

const STATUS: Record<RecommendationStatus, { label: string; variant: "default" | "outline" | "success" | "warning" }> = {
  OPEN: { label: "To do", variant: "outline" },
  PLANNED: { label: "Planned", variant: "warning" },
  IMPLEMENTED: { label: "Implemented", variant: "success" },
  DISMISSED: { label: "Dismissed", variant: "default" },
};
export function RecommendationStatusBadge({ status }: { status: RecommendationStatus }) {
  return <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>;
}
