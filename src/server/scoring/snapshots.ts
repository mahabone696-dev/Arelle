/**
 * Visibility snapshots for one scan: for every market (country × language)
 * in the scan, for "all engines" and each engine, for the primary brand and
 * every active competitor. Append-only; computed once per scan.
 */
import { db } from "@/server/db";
import type { Prisma } from "@/generated/prisma/client";
import { ANALYSIS_VERSION } from "@/server/analysis/analyze";
import { computeVisibility, resolveWeights } from "./visibility";
import { observe, type AnalyzedAnswer } from "./observe";

export { observe };

export async function computeScanSnapshots(scanId: string): Promise<number> {
  const scan = await db.scan.findUniqueOrThrow({ where: { id: scanId }, select: { projectId: true, isDemo: true, completedAt: true, createdAt: true } });
  const competitors = await db.competitor.findMany({ where: { projectId: scan.projectId, isActive: true }, select: { id: true } });
  const responses = await db.aIResponse.findMany({
    where: { scanId },
    select: {
      providerId: true,
      country: true,
      language: true,
      analyses: { where: { analysisVersion: ANALYSIS_VERSION }, select: { brandsMentionedCount: true } },
      mentions: { where: { analysisVersion: ANALYSIS_VERSION }, select: { isPrimaryBrand: true, competitorId: true, position: true, sentiment: true } },
      citations: { where: { analysisVersion: ANALYSIS_VERSION }, select: { ownerType: true, competitorId: true } },
    },
  });
  const answers: AnalyzedAnswer[] = responses
    .filter((r) => r.analyses.length)
    .map((r) => ({ providerId: r.providerId, country: r.country, language: r.language, brandsMentionedCount: r.analyses[0]!.brandsMentionedCount, mentions: r.mentions, citations: r.citations }));
  if (!answers.length) return 0;

  const { weights, version } = resolveWeights();
  const date = new Date((scan.completedAt ?? scan.createdAt).toISOString().slice(0, 10));
  const markets = [...new Set(answers.map((a) => `${a.country}|${a.language}`))];
  const rows: Prisma.VisibilitySnapshotCreateManyInput[] = [];
  for (const market of markets) {
    const [country, language] = market.split("|") as [string, string];
    const inMarket = answers.filter((a) => a.country === country && a.language === language);
    const groups: Array<[string | null, AnalyzedAnswer[]]> = [[null, inMarket], ...[...new Set(inMarket.map((a) => a.providerId))].map((p): [string, AnalyzedAnswer[]] => [p, inMarket.filter((a) => a.providerId === p)])];
    for (const [providerId, group] of groups) {
      for (const competitorId of [null, ...competitors.map((c) => c.id)]) {
        const m = computeVisibility(group.map((a) => observe(a, competitorId)), { weights, version });
        rows.push({
          projectId: scan.projectId,
          scanId,
          providerId,
          competitorId,
          country,
          language,
          date,
          visibilityScore: m.visibilityScore,
          mentionRate: m.mentionRate,
          shareOfVoice: m.shareOfVoice,
          averagePosition: m.averagePosition,
          citationRate: m.citationRate,
          sentimentScore: m.sentimentScore,
          sampleSize: m.sampleSize,
          weightsVersion: version,
          isDemo: scan.isDemo,
        });
      }
    }
  }
  // Check-and-insert under a per-scan lock so concurrent runs can't write two snapshot sets.
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`snapshots:${scanId}`}))::text AS locked`;
    if ((await tx.visibilitySnapshot.count({ where: { scanId } })) > 0) return 0;
    await tx.visibilitySnapshot.createMany({ data: rows });
    return rows.length;
  });
}
