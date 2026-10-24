/**
 * DEMO scan history for the demo workspace (non-production only).
 *
 * Generates 8 weekly scans × prompts × 3 engines of synthetic answers with a
 * deterministic PRNG, then runs them through the real analysis + snapshot code
 * so every dashboard number is computed exactly like real data. All rows are
 * flagged isDemo and every answer starts with "[DEMO DATA]".
 */
import type { PrismaClient } from "../src/generated/prisma/client";
import { analyzeScan } from "../src/server/analysis/service";
import { evaluateProject, implementRecommendation, measureActionsForScan, planRecommendation } from "../src/server/opportunities/service";

const WEEKS = 8;
const SOURCES = [
  { url: "https://www.g2.com/categories/crm", title: "Best CRM Software — G2", competitorBias: 0.9 },
  { url: "https://www.capterra.com/customer-relationship-management-software/", title: "CRM Software — Capterra", competitorBias: 0.8 },
  { url: "https://www.forbes.com/advisor/business/software/best-crm-small-business/", title: "Best CRM for Small Business — Forbes Advisor", competitorBias: 0.7 },
  { url: "https://www.reddit.com/r/sales/comments/crm_recommendations/", title: "r/sales — CRM recommendations", competitorBias: 0.4 },
  { url: "https://www.pcmag.com/picks/the-best-crm-software", title: "The Best CRM Software — PCMag", competitorBias: 0.85 },
];

/** Mulberry32: small deterministic PRNG so the demo looks the same on every seed. */
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO_PAGES = [
  { url: "https://demo-crm.example/", title: "[DEMO] Northwind CRM — the CRM for small teams", h1: ["The CRM small teams actually use"], wordCount: 640 },
  { url: "https://demo-crm.example/pricing", title: "[DEMO] Pricing — Northwind CRM", h1: ["Simple CRM pricing"], wordCount: 420 },
  { url: "https://demo-crm.example/features/pipeline", title: "[DEMO] Pipeline management — Northwind CRM", h1: ["Visual CRM pipelines"], wordCount: 880 },
  { url: "https://demo-crm.example/small-business-crm", title: "[DEMO] CRM for small companies — Northwind CRM", h1: ["An affordable CRM for small companies"], wordCount: 910 },
  { url: "https://demo-crm.example/blog/remote-sales-teams", title: "[DEMO] Managing remote sales teams", h1: ["How to manage a remote sales team"], wordCount: 1500 },
];

const PRAISE = ["easy to use and affordable", "reliable with strong pipeline views", "a popular, powerful option", "intuitive for small teams"];
const MIXED = ["capable, though it can be expensive as you grow", "flexible but has a steep learning curve", "solid, but reporting is limited"];

function buildAnswer(rand: () => number, prompt: string, brand: string, competitors: string[], week: number, engine: string) {
  // The demo brand gains visibility over time (a story to show on the trend chart).
  const pBrand = 0.25 + (0.5 * week) / (WEEKS - 1) + (engine === "perplexity" ? 0.05 : engine === "gemini" ? -0.1 : 0);
  const includeBrand = rand() < pBrand;
  const pool = [...competitors].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 2));
  const names = includeBrand ? [...pool] : pool;
  if (includeBrand) names.splice(Math.min(names.length, Math.floor(rand() * (week >= 5 ? 2 : 3))), 0, brand);
  const lines = names.map((n, i) => {
    const desc = rand() < 0.7 ? PRAISE[Math.floor(rand() * PRAISE.length)]! : MIXED[Math.floor(rand() * MIXED.length)]!;
    return `${i + 1}. ${n} – ${desc}.`;
  });
  const text = `[DEMO DATA] For "${prompt}", here are options worth comparing:\n\n${lines.join("\n")}\n\nThe right choice depends on team size and budget.`;
  const sources = SOURCES.filter((s) => rand() < (includeBrand ? 1 - s.competitorBias / 2 : s.competitorBias) * 0.7).map((s) => ({ url: s.url, title: s.title }));
  if (includeBrand && rand() < 0.15 + week * 0.05) sources.push({ url: "https://demo-crm.example/pricing", title: "Northwind CRM pricing" });
  return { text, sources };
}

export async function seedDemoScans(db: PrismaClient, projectId: string): Promise<void> {
  const existing = await db.scan.count({ where: { projectId, isDemo: true } });
  if (existing > 0) {
    console.log(`Demo scans already present (${existing}); skipping`);
    return;
  }
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { brand: { select: { name: true } }, competitors: { where: { isActive: true }, select: { name: true } }, prompts: { where: { isActive: true }, select: { id: true, text: true, country: true, language: true } } },
  });
  const providers = await db.aIProvider.findMany({ where: { slug: { in: ["openai", "gemini", "perplexity"] } }, include: { models: { where: { isDefault: true }, take: 1 } } });
  const brand = project.brand?.name ?? "Northwind CRM";
  const competitors = project.competitors.map((c) => c.name);
  // A labelled demo crawl so page matching (update vs create) has something to work with.
  if (!(await db.websiteAnalysis.count({ where: { projectId } }))) {
    await db.websiteAnalysis.create({
      data: {
        projectId,
        status: "COMPLETED",
        method: "DETERMINISTIC",
        requestedUrl: "https://demo-crm.example/",
        homepageUrl: "https://demo-crm.example/",
        site: "demo-crm.example",
        pagesCrawled: DEMO_PAGES.length,
        pages: DEMO_PAGES,
        completedAt: new Date(Date.now() - WEEKS * 7 * 86_400_000),
      },
    });
  }
  const ownerId = (await db.organizationMember.findFirst({ where: { organization: { projects: { some: { id: projectId } } }, role: "OWNER" }, select: { userId: true } }))?.userId;
  const rand = prng(20261023);
  const now = Date.now();

  for (let week = 0; week < WEEKS; week++) {
    const at = new Date(now - (WEEKS - 1 - week) * 7 * 86_400_000 - 3 * 3_600_000);
    const expected = project.prompts.length * providers.length;
    const scan = await db.scan.create({
      data: { projectId, status: "COMPLETED", scanType: "SCHEDULED", isDemo: true, promptCount: project.prompts.length, providerCount: providers.length, expectedQueryCount: expected, completedCount: expected, createdAt: at, startedAt: at, completedAt: new Date(at.getTime() + 90_000) },
    });
    for (const prompt of project.prompts) {
      for (const p of providers) {
        const { text, sources } = buildAnswer(rand, prompt.text, brand, competitors, week, p.slug);
        const job = await db.scanJob.create({
          data: { scanId: scan.id, promptId: prompt.id, providerId: p.id, modelId: p.models[0]?.id ?? null, country: prompt.country, language: prompt.language, status: "SUCCEEDED", attempts: 1, createdAt: at, finishedAt: at },
        });
        await db.aIResponse.create({
          data: {
            scanId: scan.id,
            scanJobId: job.id,
            promptId: prompt.id,
            providerId: p.id,
            modelId: p.models[0]?.id ?? null,
            model: `${p.slug}-demo`,
            country: prompt.country,
            language: prompt.language,
            promptText: prompt.text,
            rawText: text,
            normalizedText: text,
            latencyMs: 2000 + Math.floor(rand() * 4000),
            inputTokens: 1400,
            outputTokens: 380,
            estimatedCost: 0,
            metadata: { demo: true, citations: sources.map((s, i) => ({ ...s, position: i + 1 })) },
            isDemo: true,
            createdAt: new Date(at.getTime() + 60_000),
          },
        });
      }
    }
    await analyzeScan(scan.id, { llm: null, aiEnabled: async () => false });
    await evaluateProject(projectId, { scanId: scan.id, asOf: scan.completedAt! });
    await measureActionsForScan(scan.id);
    // Week 4: the demo team ships the top recommendation, so later scans show an observed before/after.
    if (week === 3 && ownerId) await implementTopRecommendation(db, projectId, ownerId, new Date(scan.completedAt!.getTime() + 2 * 86_400_000));
  }
  console.log(`Seeded ${WEEKS} demo scans (${project.prompts.length} prompts × ${providers.length} engines each)`);
}

async function implementTopRecommendation(db: PrismaClient, projectId: string, userId: string, at: Date) {
  const rec = await db.recommendation.findFirst({
    where: { status: "OPEN", opportunity: { projectId, status: "OPEN", promptId: { not: null } } },
    orderBy: [{ opportunity: { impactScore: "desc" } }, { createdAt: "asc" }],
    select: { id: true, targetUrl: true },
  });
  if (!rec) return;
  await planRecommendation(userId, projectId, rec.id);
  await implementRecommendation(userId, projectId, rec.id, { implementedAt: at, implementationUrl: rec.targetUrl ?? "", notes: "[DEMO DATA] Published the page and linked it from the homepage." }, new Date(at.getTime() + 60_000));
}
