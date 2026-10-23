import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { analyzeScan } from "@/server/analysis/service";
import {
  afterScanAnalyzed,
  evaluateProject,
  getRecommendation,
  implementRecommendation,
  listOpportunities,
  listRecommendations,
  measureActionsForScan,
  planRecommendation,
  setOpportunityStatus,
  setRecommendationStatus,
} from "@/server/opportunities/service";

const DAY = 86_400_000;
const NOW = Date.now();

async function setup() {
  const providers = [];
  for (const slug of ["openai", "gemini"]) providers.push(await db.aIProvider.create({ data: { slug, displayName: slug } }));
  const user = await db.user.create({ data: { email: `o${Math.random()}@t.com` } });
  const org = await createOrganization(user.id, { name: "Opp Co" });
  // Recommendations and action tracking are a Growth-plan feature.
  await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: "GROWTH" } });
  const project = await db.project.create({ data: { organizationId: org.id, name: "Acme CRM", domain: "acme.example", country: "US", language: "en", locale: "en-US" } });
  await db.brand.create({ data: { projectId: project.id, name: "Acme CRM", domain: "acme.example", industry: "CRM" } });
  for (const [name, domain] of [["HubSpot", "hubspot.com"], ["Pipedrive", "pipedrive.com"]]) await db.competitor.create({ data: { projectId: project.id, name: name!, domain } });
  const prompt = await db.prompt.create({ data: { projectId: project.id, text: "Best CRM for startups", intent: "COMMERCIAL", priority: 5, country: "US", language: "en", isActive: true, approvedAt: new Date() } });
  return { user, org, project, prompt, providers };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** One analyzed scan `daysAgo` days ago; `withBrand` decides whether answers list Acme CRM first. */
async function scan(ctx: Ctx, daysAgo: number, withBrand: boolean) {
  const at = new Date(NOW - daysAgo * DAY);
  const s = await db.scan.create({
    data: { projectId: ctx.project.id, status: "COMPLETED", promptCount: 1, providerCount: 2, expectedQueryCount: 2, completedCount: 2, createdAt: at, startedAt: at, completedAt: new Date(at.getTime() + 60_000) },
  });
  for (const p of ctx.providers) {
    const job = await db.scanJob.create({ data: { scanId: s.id, promptId: ctx.prompt.id, providerId: p.id, country: "US", language: "en", status: "SUCCEEDED", attempts: 1 } });
    const text = withBrand ? "Options:\n\n1. Acme CRM – easy to use and affordable.\n2. HubSpot – powerful." : "Options:\n\n1. HubSpot – powerful and popular.\n2. Pipedrive – great pipelines.";
    await db.aIResponse.create({
      data: {
        scanId: s.id,
        scanJobId: job.id,
        promptId: ctx.prompt.id,
        providerId: p.id,
        model: "test",
        country: "US",
        language: "en",
        promptText: ctx.prompt.text,
        rawText: text,
        normalizedText: text,
        latencyMs: 1,
        estimatedCost: 0,
        metadata: { citations: [{ url: "https://www.g2.com/categories/crm", title: "G2", position: 1 }] },
        createdAt: new Date(at.getTime() + 30_000),
      },
    });
  }
  await analyzeScan(s.id, { llm: null, aiEnabled: async () => false });
  return db.scan.findUniqueOrThrow({ where: { id: s.id } });
}

describe("opportunities: detection and sync", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("detects a lost prompt with recommendations, and re-evaluation never duplicates", async () => {
    const s = await scan(ctx, 3, false);
    expect(await evaluateProject(ctx.project.id, { scanId: s.id })).toMatchObject({ created: expect.any(Number), resolved: 0 });
    const ops = await listOpportunities(ctx.user.id, ctx.project.id);
    const lost = ops.find((o) => o.type === "LOST_PROMPT")!;
    expect(lost).toMatchObject({ promptId: ctx.prompt.id, status: "OPEN", scanId: s.id });
    expect(lost.recommendations.map((r) => r.type)).toEqual(["CREATE_LANDING_PAGE", "ADD_FAQ"]);
    const counts = async () => [await db.opportunity.count({ where: { projectId: ctx.project.id } }), await db.recommendation.count({ where: { opportunity: { projectId: ctx.project.id } } })];
    const before = await counts();
    await evaluateProject(ctx.project.id);
    await afterScanAnalyzed(s.id);
    expect(await counts()).toEqual(before);
  });

  it("no answers in the window → nothing changes (missing data never resolves anything)", async () => {
    await scan(ctx, 3, false);
    await evaluateProject(ctx.project.id);
    expect(await evaluateProject(ctx.project.id, { asOf: new Date(NOW + 60 * DAY) })).toBeNull();
    expect(await db.opportunity.count({ where: { projectId: ctx.project.id, status: "OPEN" } })).toBeGreaterThan(0);
  });

  it("resolves when no longer detected, reopens if it comes back; dismissals stick", async () => {
    await scan(ctx, 40, false);
    await evaluateProject(ctx.project.id, { asOf: new Date(NOW - 39 * DAY) });
    const lost = () => db.opportunity.findFirstOrThrow({ where: { projectId: ctx.project.id, type: "LOST_PROMPT" } });
    expect((await lost()).status).toBe("OPEN");

    await scan(ctx, 5, true);
    await evaluateProject(ctx.project.id);
    expect(await lost()).toMatchObject({ status: "RESOLVED", resolvedAt: expect.any(Date) });
    await expect(setOpportunityStatus(ctx.user.id, ctx.project.id, (await lost()).id, "OPEN")).rejects.toMatchObject({ code: "CONFLICT" });

    await scan(ctx, 1, false);
    await scan(ctx, 0, false);
    await evaluateProject(ctx.project.id);
    expect(await lost()).toMatchObject({ status: "OPEN", resolvedAt: null });

    await setOpportunityStatus(ctx.user.id, ctx.project.id, (await lost()).id, "DISMISSED");
    await evaluateProject(ctx.project.id);
    expect(await lost()).toMatchObject({ status: "DISMISSED", dismissedAt: expect.any(Date) });
    expect((await listOpportunities(ctx.user.id, ctx.project.id)).some((o) => o.type === "LOST_PROMPT")).toBe(false);
  });

  it("re-evaluation rewrites OPEN recommendations but never ones the user acted on", async () => {
    await scan(ctx, 3, false);
    await evaluateProject(ctx.project.id);
    const [landing, faq] = await db.recommendation.findMany({ where: { opportunity: { projectId: ctx.project.id, type: "LOST_PROMPT" } }, orderBy: { createdAt: "asc" } });
    await planRecommendation(ctx.user.id, ctx.project.id, landing!.id);
    await db.recommendation.updateMany({ where: { id: { in: [landing!.id, faq!.id] } }, data: { reason: "edited" } });
    await evaluateProject(ctx.project.id);
    expect((await db.recommendation.findUniqueOrThrow({ where: { id: landing!.id } })).reason).toBe("edited");
    expect((await db.recommendation.findUniqueOrThrow({ where: { id: faq!.id } })).reason).not.toBe("edited");
  });
});

describe("action tracking", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setup();
  });

  it("plan → implement (backdated) → observed before/after, measured once per scan", async () => {
    await scan(ctx, 20, false);
    await scan(ctx, 13, false);
    await evaluateProject(ctx.project.id, { asOf: new Date(NOW - 13 * DAY) });
    const rec = (await listRecommendations(ctx.user.id, ctx.project.id)).find((r) => r.type === "CREATE_LANDING_PAGE")!;
    await planRecommendation(ctx.user.id, ctx.project.id, rec.id);
    expect(await db.action.findFirst({ where: { recommendationId: rec.id } })).toMatchObject({ status: "PLANNED" });

    const after1 = await scan(ctx, 6, true);
    const action = await implementRecommendation(ctx.user.id, ctx.project.id, rec.id, { implementedAt: new Date(NOW - 10 * DAY).toISOString(), implementationUrl: "https://acme.example/crm-for-startups", notes: "Launched" });
    expect(action).toMatchObject({ status: "IMPLEMENTED", baselineScore: 0, baselineAnswers: 4, scopePromptIds: [ctx.prompt.id] });
    expect(await db.action.count({ where: { recommendationId: rec.id } })).toBe(1); // the planned action became the implemented one

    // Backfilled from the scan that already exists after the implementation date.
    const m1 = await db.actionMeasurement.findFirstOrThrow({ where: { actionId: action.id, scanId: after1.id } });
    expect(m1).toMatchObject({ beforeScore: 0, daysSinceImplementation: 4, afterAnswers: 2 });
    expect(m1.afterScore).toBeGreaterThan(50);
    expect(m1.delta).toBe(Math.round(m1.afterScore * 10) / 10);

    const after2 = await scan(ctx, 1, true);
    expect(await measureActionsForScan(after2.id)).toBe(1);
    expect(await measureActionsForScan(after2.id)).toBe(0); // idempotent
    const view = await getRecommendation(ctx.user.id, ctx.project.id, rec.id);
    expect(view.rec.status).toBe("IMPLEMENTED");
    expect(view.rec.actions[0]!.measurements.map((m) => m.scanId)).toEqual([after1.id, after2.id]);
    await expect(db.actionMeasurement.update({ where: { id: m1.id }, data: { afterScore: 99 } })).rejects.toThrow();
    expect((await db.actionMeasurement.findUniqueOrThrow({ where: { id: m1.id } })).afterScore).toBe(m1.afterScore);

    await expect(setRecommendationStatus(ctx.user.id, ctx.project.id, rec.id, "DISMISSED")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(implementRecommendation(ctx.user.id, ctx.project.id, rec.id, { implementedAt: new Date().toISOString() })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates input, and dismissing a plan abandons it", async () => {
    await scan(ctx, 3, false);
    await evaluateProject(ctx.project.id);
    const rec = (await listRecommendations(ctx.user.id, ctx.project.id))[0]!;
    await expect(implementRecommendation(ctx.user.id, ctx.project.id, rec.id, { implementedAt: new Date(NOW + 3 * DAY).toISOString() })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(implementRecommendation(ctx.user.id, ctx.project.id, rec.id, { implementedAt: new Date().toISOString(), implementationUrl: "javascript:alert(1)" })).rejects.toThrow();
    await planRecommendation(ctx.user.id, ctx.project.id, rec.id);
    await setRecommendationStatus(ctx.user.id, ctx.project.id, rec.id, "DISMISSED");
    expect(await db.action.findFirst({ where: { recommendationId: rec.id } })).toMatchObject({ status: "ABANDONED" });
    await setRecommendationStatus(ctx.user.id, ctx.project.id, rec.id, "OPEN");
    await planRecommendation(ctx.user.id, ctx.project.id, rec.id);
    expect(await db.action.count({ where: { recommendationId: rec.id, status: "PLANNED" } })).toBe(1);
  });

  it("concurrent clicks create one action; opportunities for prompts you stop tracking are hidden", async () => {
    await scan(ctx, 3, false);
    await evaluateProject(ctx.project.id);
    const rec = (await listRecommendations(ctx.user.id, ctx.project.id))[0]!;
    await Promise.all([1, 2, 3].map(() => planRecommendation(ctx.user.id, ctx.project.id, rec.id)));
    expect(await db.action.count({ where: { recommendationId: rec.id } })).toBe(1);
    const results = await Promise.allSettled([1, 2].map(() => implementRecommendation(ctx.user.id, ctx.project.id, rec.id, { implementedAt: new Date().toISOString() })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.action.count({ where: { recommendationId: rec.id } })).toBe(1);

    expect((await listOpportunities(ctx.user.id, ctx.project.id)).length).toBeGreaterThan(0);
    await db.prompt.update({ where: { id: ctx.prompt.id }, data: { isActive: false } });
    await evaluateProject(ctx.project.id);
    for (const status of ["OPEN", "RESOLVED"] as const) expect((await listOpportunities(ctx.user.id, ctx.project.id, { status })).filter((o) => o.promptId)).toEqual([]);
  });

  it("authorization: viewers read but can't act; other orgs see nothing", async () => {
    await scan(ctx, 3, false);
    await evaluateProject(ctx.project.id);
    const rec = (await listRecommendations(ctx.user.id, ctx.project.id))[0]!;
    const viewer = await db.user.create({ data: { email: `v${Math.random()}@t.com` } });
    await db.organizationMember.create({ data: { organizationId: ctx.org.id, userId: viewer.id, role: "VIEWER" } });
    expect((await getRecommendation(viewer.id, ctx.project.id, rec.id)).rec.id).toBe(rec.id);
    await expect(planRecommendation(viewer.id, ctx.project.id, rec.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const mallory = await db.user.create({ data: { email: `m${Math.random()}@t.com` } });
    const other = await createOrganization(mallory.id, { name: "Other" });
    await db.subscription.update({ where: { organizationId: other.id }, data: { planTier: "GROWTH" } });
    const otherProject = await db.project.create({ data: { organizationId: other.id, name: "X", domain: "x.example", country: "US", language: "en", locale: "en-US" } });
    await expect(listRecommendations(mallory.id, ctx.project.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A recommendation id from another project is not reachable through your own project.
    await expect(getRecommendation(mallory.id, otherProject.id, rec.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(planRecommendation(mallory.id, otherProject.id, rec.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
