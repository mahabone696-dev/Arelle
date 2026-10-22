/**
 * Scan analysis job: every AI answer in a finished scan → ResponseAnalysis,
 * BrandMention and Citation rows (append-only, per analysisVersion), then
 * visibility snapshots. Idempotent: answers already analyzed at the current
 * version are skipped, so retries and re-runs never duplicate rows.
 */
import { db } from "@/server/db";
import { isFeatureEnabled } from "@/server/flags/flags";
import { getOnboardingLLM } from "@/server/ai/config";
import type { StructuredLLMClient } from "@/server/ai/types";
import { recordAiUsage } from "@/server/onboarding/usage";
import { Prisma } from "@/generated/prisma/client";
import { logger } from "@/lib/logger";
import { ANALYSIS_VERSION, analyzeResponse, type AnalysisResult, type BrandContext } from "./analyze";
import { enrichWithAI, needsAiEnrichment } from "./ai-enrich";
import type { RawCitation } from "./citations";
import { computeScanSnapshots } from "@/server/scoring/snapshots";

const log = logger.child({ component: "analysis" });

export interface AnalysisDeps {
  /** Null disables AI enrichment. */
  llm: StructuredLLMClient | null;
  aiEnabled: () => Promise<boolean>;
}

export const defaultAnalysisDeps = (): AnalysisDeps => ({ llm: getOnboardingLLM(), aiEnabled: () => isFeatureEnabled("analysisAi") });

/** Scans whose answers can be analyzed: finished with at least one answer. */
const ANALYZABLE = ["COMPLETED", "PARTIAL", "CANCELLED"] as const;

export async function loadBrandContext(projectId: string): Promise<BrandContext> {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true, domain: true, brand: { select: { name: true, aliases: true, domain: true } }, competitors: { where: { isActive: true }, select: { id: true, name: true, aliases: true, domain: true } } },
  });
  return {
    primary: { name: project.brand?.name ?? project.name, aliases: project.brand?.aliases ?? [], domain: project.brand?.domain ?? project.domain },
    competitors: project.competitors,
  };
}

async function persistAnalysis(responseId: string, result: AnalysisResult): Promise<boolean> {
  try {
    await db.$transaction(async (tx) => {
      await tx.responseAnalysis.create({
        data: {
          responseId,
          analysisVersion: result.analysisVersion,
          method: result.method,
          primaryMentioned: result.primaryBrand.mentioned,
          primaryPosition: result.primaryBrand.position,
          primarySentiment: result.primaryBrand.sentiment,
          recommendationStrength: result.primaryBrand.recommendationStrength,
          primaryCited: result.primaryBrand.cited,
          brandsMentionedCount: result.brandsMentionedCount,
          citationCount: result.citations.length,
          result: JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue,
        },
      });
      if (result.mentions.length) {
        await tx.brandMention.createMany({
          data: result.mentions.map((m) => ({
            responseId,
            analysisVersion: result.analysisVersion,
            competitorId: m.competitorId,
            brandName: m.name,
            brandDomain: m.domain,
            mentionType: m.key === "primary" ? ("PRIMARY" as const) : ("COMPETITOR" as const),
            position: m.position,
            sentiment: m.sentiment,
            recommendationStrength: m.recommendationStrength,
            confidence: m.confidence,
            isPrimaryBrand: m.key === "primary",
            extractionMethod: result.method,
            occurrences: m.occurrences,
            snippet: m.snippet,
          })),
        });
      }
      if (result.citations.length) {
        await tx.citation.createMany({
          data: result.citations.map((c) => ({
            responseId,
            analysisVersion: result.analysisVersion,
            url: c.url,
            normalizedUrl: c.normalizedUrl,
            domain: c.domain,
            title: c.title,
            position: c.position,
            ownerType: c.ownerType,
            competitorId: c.competitorId,
          })),
        });
      }
    });
    return true;
  } catch (error) {
    // Already analyzed at this version by a concurrent run.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return false;
    throw error;
  }
}

export async function analyzeScan(scanId: string, deps: AnalysisDeps = defaultAnalysisDeps()): Promise<{ analyzed: number; snapshots: number } | null> {
  const scan = await db.scan.findUnique({ where: { id: scanId }, select: { id: true, status: true, projectId: true, completedCount: true, analysisStatus: true, project: { select: { organizationId: true } } } });
  if (!scan || !ANALYZABLE.includes(scan.status as (typeof ANALYZABLE)[number]) || scan.completedCount === 0) return null;
  if (scan.analysisStatus === "COMPLETED") return null;

  await db.scan.update({ where: { id: scanId }, data: { analysisStatus: "RUNNING", analysisError: null } });
  try {
    const ctx = await loadBrandContext(scan.projectId);
    const useAi = deps.llm !== null && (await deps.aiEnabled());
    const responses = await db.aIResponse.findMany({
      where: { scanId, analyses: { none: { analysisVersion: ANALYSIS_VERSION } } },
      select: { id: true, rawText: true, normalizedText: true, language: true, metadata: true },
    });
    let analyzed = 0;
    for (const r of responses) {
      const providerCitations = ((r.metadata as { citations?: RawCitation[] } | null)?.citations ?? []).filter((c) => typeof c?.url === "string");
      let result = analyzeResponse({ normalizedText: r.normalizedText, rawText: r.rawText, language: r.language, providerCitations }, ctx);
      if (useAi && needsAiEnrichment(result)) {
        const enriched = await enrichWithAI(deps.llm!, result, r.normalizedText, r.language);
        result = enriched.result;
        if (enriched.usage) await recordAiUsage(scan.project.organizationId, enriched.usage, r.id);
      }
      if (await persistAnalysis(r.id, result)) analyzed++;
    }
    const snapshots = await computeScanSnapshots(scanId);
    await db.scan.update({ where: { id: scanId }, data: { analysisStatus: "COMPLETED", analysisCompletedAt: new Date() } });
    log.info("analysis.scan_completed", { scanId, analyzed, snapshots, ai: useAi });
    return { analyzed, snapshots };
  } catch (error) {
    await db.scan.update({ where: { id: scanId }, data: { analysisStatus: "FAILED", analysisError: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error" } });
    log.error("analysis.scan_failed", { scanId, error });
    throw error;
  }
}
