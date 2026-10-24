/**
 * Plan limits are enforced on the server, whatever the UI shows.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { createProject } from "@/server/projects/service";
import { createScan, defaultScanDeps, previewScan } from "@/server/scans/service";
import { evaluateProject, listOpportunities, listRecommendations } from "@/server/opportunities/service";
import { getOrgPlan } from "@/server/billing/limits";
import { effectiveTier, PLANS } from "@/server/billing/plans";
import type { PlanTier, SubscriptionStatus } from "@/generated/prisma/enums";

const noQueue = () => ({ ...defaultScanDeps(), enqueueDispatch: async () => {} });
const DAY = 86_400_000;

beforeAll(() => {
  process.env.OPENAI_API_KEY = "sk-test-not-real";
  process.env.OPENAI_SCAN_MODEL = "gpt-4.1-mini";
  process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
});

beforeEach(async () => {
  const openai = await db.aIProvider.create({ data: { slug: "openai", displayName: "ChatGPT", isEnabled: true, dailyQueryCap: 100_000 } });
  await db.aIModel.create({ data: { providerId: openai.id, modelId: "gpt-4.1-mini", displayName: "GPT-4.1 mini", inputCostPer1M: 0.4, outputCostPer1M: 1.6, requestCost: 0.025, isDefault: true } });
});

async function org(tier: PlanTier = "FREE", status: SubscriptionStatus = "ACTIVE") {
  const user = await db.user.create({ data: { email: `b${Math.random()}@t.com` } });
  const o = await createOrganization(user.id, { name: "Billing Co" });
  await db.subscription.update({ where: { organizationId: o.id }, data: { planTier: tier, status } });
  return { user, org: o };
}

let n = 0;
async function project(ctx: { user: { id: string }; org: { id: string } }, prompts = 3) {
  const p = await createProject(ctx.user.id, ctx.org.id, { name: "Site", domain: `site${++n}${Math.floor(Math.random() * 1e6)}.com`, country: "US", language: "en" });
  for (let i = 0; i < prompts; i++) await db.prompt.create({ data: { projectId: p.id, text: `Prompt ${i}`, intent: "COMMERCIAL", country: "US", language: "en", isActive: true, approvedAt: new Date() } });
  return p;
}

describe("effective plan", () => {
  it("canceled / unpaid / incomplete subscriptions fall back to Free; past-due keeps the plan (grace)", () => {
    expect(effectiveTier({ planTier: "GROWTH", status: "ACTIVE" })).toBe("GROWTH");
    expect(effectiveTier({ planTier: "GROWTH", status: "TRIALING" })).toBe("GROWTH");
    expect(effectiveTier({ planTier: "GROWTH", status: "PAST_DUE" })).toBe("GROWTH");
    for (const status of ["CANCELED", "UNPAID", "INCOMPLETE"] as const) expect(effectiveTier({ planTier: "AGENCY", status })).toBe("FREE");
    expect(effectiveTier(null)).toBe("FREE");
    expect(PLANS.GROWTH.limits).toMatchObject({ projects: 3, prompts: 200, actionEngine: true });
    expect(PLANS.STARTER.limits).toMatchObject({ projects: 1, prompts: 50, actionEngine: false });
  });
});

describe("projects", () => {
  it("Free allows one project; concurrent creations can't sneak past the limit; duplicates say so", async () => {
    const ctx = await org("FREE");
    const results = await Promise.allSettled([1, 2, 3].map((i) => createProject(ctx.user.id, ctx.org.id, { name: `P${i}`, domain: `p${i}-${Date.now()}.com`, country: "US", language: "en" })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "projects", upgrade: true } });
    const existing = (await db.project.findFirstOrThrow({ where: { organizationId: ctx.org.id } })).domain;
    await expect(createProject(ctx.user.id, ctx.org.id, { name: "Again", domain: existing, country: "US", language: "en" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("after a downgrade, projects over the limit stay readable but stop scanning", async () => {
    const ctx = await org("GROWTH");
    const first = await project(ctx);
    const second = await project(ctx);
    await db.subscription.update({ where: { organizationId: ctx.org.id }, data: { status: "CANCELED" } });
    await expect(createScan(ctx.user.id, second.id, {}, noQueue())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "projects" } });
    expect((await previewScan(ctx.user.id, second.id, noQueue())).upgradeRequired).toBe(true);
    await expect(createScan(ctx.user.id, first.id, {}, noQueue())).resolves.toMatchObject({ status: "QUEUED" });
  });
});

describe("scans", () => {
  it("cadence: Free scans a project once a week; failed scans don't count", async () => {
    const ctx = await org("FREE");
    const p = await project(ctx);
    const s = await createScan(ctx.user.id, p.id, {}, noQueue());
    await db.scan.update({ where: { id: s.id }, data: { status: "FAILED" } });
    const ok = await createScan(ctx.user.id, p.id, {}, noQueue());
    await db.scan.update({ where: { id: ok.id }, data: { status: "COMPLETED" } });
    await expect(createScan(ctx.user.id, p.id, {}, noQueue())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "cadence" } });
    const preview = await previewScan(ctx.user.id, p.id, noQueue());
    expect(preview.blockedReason).toMatch(/once a week/);
    expect(preview.upgradeRequired).toBe(false);
    // Eight days later it's allowed again (manual scans/day reset too).
    await db.scan.updateMany({ where: { projectId: p.id }, data: { createdAt: new Date(Date.now() - 8 * DAY) } });
    await expect(createScan(ctx.user.id, p.id, {}, noQueue())).resolves.toBeTruthy();
  });

  it("monthly query allowance counts every scan this month", async () => {
    const ctx = await org("FREE");
    const p = await project(ctx, 5);
    const provider = await db.aIProvider.findUniqueOrThrow({ where: { slug: "openai" } });
    const prompts = await db.prompt.findMany({ where: { projectId: p.id } });
    const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    const at = new Date(Math.max(monthStart + 60_000, Date.now() - 9 * DAY)); // this month, outside cadence/day windows when possible
    // 30 earlier scans × 5 prompts = 150 jobs this month; 2 were skipped (never cost anything) → 148 of Free's 150 used.
    for (let i = 0; i < 30; i++) {
      const old = await db.scan.create({ data: { projectId: p.id, status: "COMPLETED", expectedQueryCount: 5, createdAt: new Date(Date.now() - 9 * DAY) } });
      await db.scanJob.createMany({ data: prompts.map((pr, k) => ({ scanId: old.id, promptId: pr.id, providerId: provider.id, country: "US", language: "en", status: i === 0 && k < 2 ? ("SKIPPED" as const) : ("SUCCEEDED" as const), createdAt: at })) });
    }
    await expect(createScan(ctx.user.id, p.id, {}, noQueue())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", details: { limit: "queriesPerMonth", used: 148, max: 150 } });
  });

  it("a canceled Growth subscription gets Free's prompt limit", async () => {
    const ctx = await org("GROWTH", "CANCELED");
    const p = await project(ctx, 12);
    expect(await getOrgPlan(ctx.org.id)).toMatchObject({ tier: "FREE" });
    const scan = await createScan(ctx.user.id, p.id, {}, noQueue());
    expect(scan.promptCount).toBe(10);
  });
});

describe("Action Engine gate", () => {
  it("Free and Starter see opportunities, not recommendations; Growth sees both", async () => {
    for (const [tier, allowed] of [["FREE", false], ["STARTER", false], ["GROWTH", true]] as const) {
      const ctx = await org(tier);
      const p = await project(ctx, 1);
      await evaluateProject(p.id);
      await expect(listOpportunities(ctx.user.id, p.id)).resolves.toBeDefined();
      if (allowed) await expect(listRecommendations(ctx.user.id, p.id)).resolves.toBeDefined();
      else await expect(listRecommendations(ctx.user.id, p.id)).rejects.toMatchObject({ code: "FEATURE_DISABLED", details: { needed: "GROWTH", upgrade: true } });
    }
  });
});
