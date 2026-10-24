/**
 * Scan → worker → analysis → snapshots, end to end, on crafted answers whose
 * expected metrics are computed by hand below.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Redis } from "ioredis";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { createProject } from "@/server/projects/service";
import { createScan } from "@/server/scans/service";
import { startScanWorkers } from "@/server/queue/workers";
import { closeQueues } from "@/server/queue/queues";
import { closeSharedRedis } from "@/server/queue/connection";
import { analyzeScan } from "@/server/analysis/service";
import { saveCompetitors } from "@/server/onboarding/service";
import { openAIAnswer } from "../helpers/fake-openai-responses";

const REDIS_TEST_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

// Prompt → answer + provider citations.
const ANSWERS: Record<string, { text: string; citations: Array<{ url: string; title?: string }> }> = {
  "Best CRM": { text: "1. HubSpot – the best overall choice.\n2. Northwind – affordable.", citations: [{ url: "https://www.hubspot.com/crm?utm_source=openai" }, { url: "https://www.g2.com/categories/crm" }] },
  "CRM for startups": { text: "Northwind is the top pick and reliable. Pipedrive is another option.", citations: [{ url: "https://northwind.com/pricing" }] },
  "Popular CRMs": { text: "HubSpot and Pipedrive are popular.", citations: [] },
  "CRM advice": { text: "It depends on your needs.", citations: [] },
};

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const a = ANSWERS[JSON.parse(body).input as string]!;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(openAIAnswer(a.text, { citations: a.citations.map((c, i) => ({ ...c, at: i })) })));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    OPENAI_API_KEY: "sk-test-not-real",
    OPENAI_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    OPENAI_SCAN_MODEL: "gpt-4.1-mini",
    REDIS_URL: REDIS_TEST_URL,
    SCAN_JOB_BACKOFF_MS: "20",
  });
});
afterAll(async () => {
  await closeQueues();
  await closeSharedRedis();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(async () => {
  const r = new Redis(REDIS_TEST_URL);
  await r.flushdb();
  await r.quit();
  const p = await db.aIProvider.create({ data: { slug: "openai", displayName: "ChatGPT", isEnabled: true, maxConcurrency: 4, requestsPerMinute: 600 } });
  await db.aIModel.create({ data: { providerId: p.id, modelId: "gpt-4.1-mini", displayName: "m", inputCostPer1M: 0.4, outputCostPer1M: 1.6, requestCost: 0.025 } });
});

async function setup() {
  const user = await db.user.create({ data: { email: `a${Math.random()}@t.com` } });
  const org = await createOrganization(user.id, { name: "Analysis Co" });
  await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: "GROWTH" } });
  const project = await createProject(user.id, org.id, { name: "Northwind", domain: "northwind.com", country: "US", language: "en" });
  await db.brand.create({ data: { projectId: project.id, name: "Northwind", domain: "northwind.com" } });
  const [hubspot, pipedrive] = await Promise.all([
    db.competitor.create({ data: { projectId: project.id, name: "HubSpot", domain: "hubspot.com" } }),
    db.competitor.create({ data: { projectId: project.id, name: "Pipedrive", domain: "pipedrive.com" } }),
  ]);
  for (const text of Object.keys(ANSWERS)) await db.prompt.create({ data: { projectId: project.id, text, intent: "COMMERCIAL", country: "US", language: "en", isActive: true, approvedAt: new Date() } });
  return { user, org, project, hubspot, pipedrive };
}

async function runScanToAnalysis(userId: string, projectId: string) {
  const scan = await createScan(userId, projectId);
  const workers = await startScanWorkers({ sweepEveryMs: 0 });
  try {
    for (const started = Date.now(); ; ) {
      const s = await db.scan.findUniqueOrThrow({ where: { id: scan.id } });
      if (s.analysisStatus === "COMPLETED" || s.analysisStatus === "FAILED") return s;
      if (Date.now() - started > 20_000) throw new Error(`timeout: ${s.status}/${s.analysisStatus}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await workers.close();
  }
}

describe("analysis pipeline", () => {
  it("analyzes every answer after the scan and writes hand-verifiable snapshots", async () => {
    const { user, project, hubspot, pipedrive } = await setup();
    const scan = await runScanToAnalysis(user.id, project.id);
    expect(scan).toMatchObject({ status: "COMPLETED", analysisStatus: "COMPLETED" });

    expect(await db.responseAnalysis.count({ where: { response: { scanId: scan.id } } })).toBe(4);
    const mentions = await db.brandMention.findMany({ where: { response: { scanId: scan.id } }, include: { response: { select: { promptText: true } } } });
    const byPrompt = (p: string) => mentions.filter((m) => m.response.promptText === p).sort((a, b) => a.position - b.position).map((m) => [m.brandName, m.position, m.mentionType]);
    expect(byPrompt("Best CRM")).toEqual([["HubSpot", 1, "COMPETITOR"], ["Northwind", 2, "PRIMARY"]]);
    expect(byPrompt("CRM for startups")).toEqual([["Northwind", 1, "PRIMARY"], ["Pipedrive", 2, "COMPETITOR"]]);
    expect(byPrompt("CRM advice")).toEqual([]);

    const citations = await db.citation.findMany({ where: { response: { scanId: scan.id } }, orderBy: { position: "asc" } });
    expect(citations.map((c) => [c.normalizedUrl, c.ownerType]).sort()).toEqual([
      ["g2.com/categories/crm", "THIRD_PARTY"],
      ["hubspot.com/crm", "COMPETITOR"],
      ["northwind.com/pricing", "PRIMARY"],
    ]);
    expect(citations.find((c) => c.domain === "hubspot.com")!.competitorId).toBe(hubspot.id);

    // Primary brand, all engines (verified by hand):
    //   answers: Best CRM (rank 2, "affordable" → +0.5, not cited, 2 brands)
    //            CRM for startups (rank 1, "top pick"+"reliable" → 2/3 = 0.67, cited, 2 brands)
    //            Popular CRMs (absent, 2 brands) · CRM advice (absent, 0 brands)
    //   mentionRate 2/4 = 0.5 · positionScore (0.6667 + 1)/2 = 0.8333 · SoV 2/6 = 0.3333
    //   citationRate 1/4 = 0.25 · sentiment (0.5 + 0.67)/2 = 0.585 → 0.7925
    //   score = 100 × (0.35·0.5 + 0.25·0.8333 + 0.2·0.3333 + 0.1·0.25 + 0.1·0.7925) = 55.4
    const primaryAll = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: scan.id, providerId: null, competitorId: null } });
    expect(primaryAll).toMatchObject({ sampleSize: 4, mentionRate: 0.5, shareOfVoice: 0.3333, citationRate: 0.25, averagePosition: 1.5, weightsVersion: "w1:35-25-20-10-10", country: "US", language: "en", isDemo: false });
    expect(primaryAll.sentimentScore).toBeCloseTo(0.585, 3);
    expect(primaryAll.visibilityScore).toBe(55.4);

    // HubSpot: ranks 1,1 in Best CRM / Popular CRMs, cited once → mention 0.5, position 1, SoV 2/6, cited 0.25.
    const hs = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: scan.id, providerId: null, competitorId: hubspot.id } });
    expect(hs).toMatchObject({ mentionRate: 0.5, averagePosition: 1, shareOfVoice: 0.3333, citationRate: 0.25 });
    // Pipedrive: ranks 2,2, never cited.
    const pd = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: scan.id, providerId: null, competitorId: pipedrive.id } });
    expect(pd).toMatchObject({ mentionRate: 0.5, averagePosition: 2, citationRate: 0 });

    // One "all engines" + one per-engine snapshot for each of the 3 subjects.
    expect(await db.visibilitySnapshot.count({ where: { scanId: scan.id } })).toBe(6);
    const perEngine = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: scan.id, providerId: { not: null }, competitorId: null } });
    expect(perEngine.visibilityScore).toBe(55.4);
  });

  it("is idempotent, append-only, and preserves competitor history", async () => {
    const { user, project, pipedrive, hubspot } = await setup();
    const scan = await runScanToAnalysis(user.id, project.id);
    const counts = async () => [await db.responseAnalysis.count(), await db.brandMention.count(), await db.citation.count(), await db.visibilitySnapshot.count()];
    const before = await counts();
    await db.scan.update({ where: { id: scan.id }, data: { analysisStatus: null } });
    expect(await analyzeScan(scan.id)).toEqual({ analyzed: 0, snapshots: 0 });
    expect(await counts()).toEqual(before);

    const m = await db.brandMention.findFirstOrThrow();
    await expect(db.brandMention.update({ where: { id: m.id }, data: { position: 99 } })).rejects.toThrow();
    const snap = await db.visibilitySnapshot.findFirstOrThrow();
    await expect(db.visibilitySnapshot.update({ where: { id: snap.id }, data: { visibilityScore: 100 } })).rejects.toThrow();

    // Removing a competitor that has history deactivates it instead of deleting (which would rewrite history).
    await saveCompetitors(user.id, project.id, [{ id: hubspot.id, name: "HubSpot", domain: "hubspot.com" }]);
    expect(await db.competitor.findUniqueOrThrow({ where: { id: pipedrive.id } })).toMatchObject({ isActive: false });
    expect(await db.brandMention.count({ where: { competitorId: pipedrive.id } })).toBe(2);
  });

  it("skips scans without answers", async () => {
    const { project } = await setup();
    const failed = await db.scan.create({ data: { projectId: project.id, status: "FAILED", expectedQueryCount: 4 } });
    expect(await analyzeScan(failed.id)).toBeNull();
  });
});

describe("history and deletion", () => {
  it("deleting an organization removes its full scan/analysis history (no append-only trigger conflicts)", async () => {
    const { user, org, project } = await setup();
    await runScanToAnalysis(user.id, project.id);
    expect(await db.visibilitySnapshot.count()).toBeGreaterThan(0);
    await db.organization.delete({ where: { id: org.id } });
    expect([await db.aIResponse.count(), await db.brandMention.count(), await db.citation.count(), await db.visibilitySnapshot.count(), await db.responseAnalysis.count()]).toEqual([0, 0, 0, 0, 0]);
  });

  it("models referenced by stored answers cannot be deleted", async () => {
    const { user, project } = await setup();
    await runScanToAnalysis(user.id, project.id);
    await expect(db.aIModel.deleteMany({})).rejects.toThrow();
  });
});
