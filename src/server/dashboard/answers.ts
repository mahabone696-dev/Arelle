import { db } from "@/server/db";
import { ANALYSIS_VERSION } from "@/server/analysis/analyze";
import type { AnswerRow } from "./aggregate";

export interface AnswerFilter {
  promptId?: string;
  promptIds?: string[];
  providerId?: string;
}

/**
 * Analyzed answers for a project in [from, to), oldest first. Only answers
 * analyzed at the current version count. `isDemo` must match the workspace:
 * demo answers only ever appear in demo workspaces, and vice versa.
 */
export async function loadProjectAnswers(projectId: string, isDemo: boolean, from: Date, to: Date, filter: AnswerFilter = {}): Promise<AnswerRow[]> {
  const rows = await db.aIResponse.findMany({
    where: {
      scan: { projectId },
      isDemo,
      createdAt: { gte: from, lt: to },
      analyses: { some: { analysisVersion: ANALYSIS_VERSION } },
      ...(filter.promptId ? { promptId: filter.promptId } : filter.promptIds ? { promptId: { in: filter.promptIds } } : {}),
      ...(filter.providerId ? { providerId: filter.providerId } : {}),
    },
    select: {
      id: true,
      promptId: true,
      providerId: true,
      createdAt: true,
      country: true,
      language: true,
      analyses: { where: { analysisVersion: ANALYSIS_VERSION }, select: { brandsMentionedCount: true } },
      mentions: { where: { analysisVersion: ANALYSIS_VERSION }, select: { isPrimaryBrand: true, competitorId: true, brandName: true, position: true, sentiment: true, snippet: true } },
      citations: { where: { analysisVersion: ANALYSIS_VERSION }, select: { ownerType: true, competitorId: true, domain: true, url: true, title: true, position: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    responseId: r.id,
    promptId: r.promptId,
    providerId: r.providerId,
    createdAt: r.createdAt,
    country: r.country,
    language: r.language,
    brandsMentionedCount: r.analyses[0]!.brandsMentionedCount,
    mentions: r.mentions,
    citations: r.citations,
  }));
}
