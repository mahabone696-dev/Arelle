import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import {
  generatePrompts,
  getOnboardingState,
  runWebsiteAnalysis,
  saveBrandProfile,
  saveCompetitors,
  savePromptReview,
  startOnboarding,
  suggestCompetitors,
  type OnboardingDeps,
} from "@/server/onboarding/service";
import { extractPage } from "@/server/crawler/extract";
import { CrawlError } from "@/server/crawler/errors";
import type { CrawlResult } from "@/server/crawler/crawler";
import { PROMPT_DISTRIBUTION, PROMPT_INTENTS } from "@/server/onboarding/intents";
import { AppError } from "@/lib/errors";
import { LLMError, type LLMRequest } from "@/server/ai/types";
import { fakeLLM } from "../helpers/fake-llm";

const HOME = `<html lang="en"><head><title>Northwind — CRM for startups</title><meta name="description" content="Northwind is the CRM for fast-growing sales teams.">
<script type="application/ld+json">{"@type":"Organization","name":"Northwind"}</script></head>
<body><main><h1>Close more deals</h1><h2>Pipeline management</h2><p>Track leads and deals.</p></main></body></html>`;

function fakeCrawl(domain: string): CrawlResult {
  const url = `https://${domain}/`;
  return {
    requestedUrl: url,
    site: domain,
    homepageUrl: url,
    robots: { status: "PARSED", homepageOnly: false },
    sitemapUrlCount: 3,
    pages: [extractPage(HOME, url), extractPage(`<title>Pricing</title><main><p>Plans from $10</p></main>`, `${url}pricing`)],
    failures: [],
    stats: { requests: 4, bytes: 1000, durationMs: 10 },
  };
}

const brandJson = { brandName: "Northwind", description: "CRM for startups", industry: "CRM software", products: ["Northwind CRM"], services: [], targetCustomers: ["startups"], markets: ["United States"], topics: ["Pipeline management"] };
const competitorsJson = {
  competitors: [
    { name: "HubSpot", domain: "hubspot.com", reason: "SMB CRM leader", confidence: 0.95 },
    { name: "Pipedrive", domain: "pipedrive.com", reason: "Pipeline CRM", confidence: 0.9 },
    { name: "Salesforce", domain: "salesforce.com", reason: "Enterprise CRM", confidence: 0.85 },
    { name: "Zoho CRM", domain: "zoho.com", reason: "Budget CRM", confidence: 0.8 },
    { name: "Close", domain: "close.com", reason: "Startup CRM", confidence: 0.75 },
    { name: "Northwind", domain: "northwind.com", reason: "self", confidence: 1 },
  ],
};

function promptsJson(quotas: Record<string, number>) {
  return {
    prompts: PROMPT_INTENTS.flatMap((intent) =>
      Array.from({ length: quotas[intent] ?? 0 }, (_, i) => ({
        text: intent === "BRANDED" ? `Northwind review ${i}` : intent === "COMPARISON" ? `HubSpot vs Pipedrive ${i}` : `${intent.toLowerCase()} crm question ${i}`,
        intent,
        cluster: intent === "BRANDED" ? "Brand" : "CRM for startups",
        priority: 4,
        country: "US",
        language: "en",
        reason: "Matters",
      })),
    ),
  };
}

/** Routes fake replies by schema name, like a real model would answer each request type. */
function routedLLM() {
  return fakeLLM((req: LLMRequest) => {
    if (req.schemaName === "brand_profile") return brandJson;
    if (req.schemaName === "competitor_suggestions") return competitorsJson;
    return promptsJson(PROMPT_DISTRIBUTION);
  });
}

async function setup(email = "owner@nw.com") {
  const user = await db.user.create({ data: { email } });
  const org = await createOrganization(user.id, { name: "NW Org" });
  return { user, org };
}

const market = { country: "US", language: "en", timezone: "America/New_York" };

describe("onboarding flow (AI)", () => {
  it("runs domain → analysis → brand → competitors → 30 prompts → review → complete", async () => {
    const { user, org } = await setup();
    const llm = routedLLM();
    const deps: OnboardingDeps = { llm, crawl: async (url) => fakeCrawl(new URL(url).hostname) };

    const { projectId, analysis } = await startOnboarding(user.id, org.id, { url: "https://www.northwind.com/pricing", ...market }, deps);
    expect(analysis).toMatchObject({ status: "COMPLETED", method: "AI", pagesCrawled: 2, aiProvider: "fake", aiAttempts: 1, inputTokens: 100 });
    let state = await getOnboardingState(user.id, projectId);
    expect(state.project).toMatchObject({ name: "Northwind", domain: "northwind.com", onboardingStep: "BRAND" });
    expect(state.brand).toMatchObject({ name: "Northwind", industry: "CRM software", targetCustomers: ["startups"] });
    // Website text is passed as delimited untrusted content.
    expect(llm.requests[0]!.user).toContain("<website_content");

    await saveBrandProfile(user.id, projectId, { ...brandJson, industry: "CRM software for startups", aliases: ["Northwind CRM"] });
    const comp = await suggestCompetitors(user.id, projectId, deps);
    expect(comp).toEqual({ method: "AI", added: 5 });
    state = await getOnboardingState(user.id, projectId);
    expect(state.competitors.map((c) => c.name)).toEqual(["HubSpot", "Pipedrive", "Salesforce", "Zoho CRM", "Close"]);
    expect(state.competitors[0]).toMatchObject({ source: "AI_SUGGESTED", domain: "hubspot.com", reason: "SMB CRM leader" });
    // Calling again doesn't spend another AI call.
    expect(await suggestCompetitors(user.id, projectId, deps)).toEqual({ method: "EXISTING", added: 0 });

    // User edits: remove Close, rename Zoho, add Freshsales.
    const keep = state.competitors.filter((c) => c.name !== "Close").map((c) => ({ id: c.id, name: c.name === "Zoho CRM" ? "Zoho" : c.name, domain: c.domain ?? "" }));
    await saveCompetitors(user.id, projectId, [...keep, { name: "Freshsales", domain: "https://www.freshworks.com/crm" }]);
    state = await getOnboardingState(user.id, projectId);
    expect(state.competitors.map((c) => [c.name, c.domain]).sort()).toEqual([
      ["Freshsales", "freshworks.com"],
      ["HubSpot", "hubspot.com"],
      ["Pipedrive", "pipedrive.com"],
      ["Salesforce", "salesforce.com"],
      ["Zoho", "zoho.com"],
    ]);
    expect(state.project.onboardingStep).toBe("PROMPTS");

    const gen = await generatePrompts(user.id, projectId, deps);
    expect(gen).toMatchObject({ method: "AI", created: 30 });
    state = await getOnboardingState(user.id, projectId);
    expect(state.prompts).toHaveLength(30);
    const byIntent = Object.fromEntries(PROMPT_INTENTS.map((i) => [i, state.prompts.filter((p) => p.intent === i).length]));
    expect(byIntent).toEqual(PROMPT_DISTRIBUTION);
    for (const p of state.prompts) {
      expect(p).toMatchObject({ country: "US", language: "en", isActive: false, approvedAt: null, source: "AI_SUGGESTED" });
      expect(p.reason && p.cluster?.name && p.priority).toBeTruthy();
    }
    const promptReq = llm.requests.find((r) => r.schemaName === "prompt_set")!;
    expect(JSON.parse(promptReq.user).competitors).toEqual(expect.arrayContaining(["Freshsales", "Zoho"]));

    // Review: approve 25, delete 3, edit 1, add 1, leave 1 pending.
    const [edited, ...rest] = state.prompts;
    const toDelete = rest.slice(0, 3).map((p) => p.id);
    const pendingOne = rest[3]!;
    const items = [
      { id: edited!.id, text: "Best CRM for seed-stage startups", intent: "COMMERCIAL" as const, cluster: "CRM for startups", priority: 5, approved: true },
      ...rest.slice(4).map((p) => ({ id: p.id, text: p.text, intent: p.intent, cluster: p.cluster!.name, priority: p.priority, approved: true })),
      { id: pendingOne.id, text: pendingOne.text, intent: pendingOne.intent, cluster: "Brand", priority: 2, approved: false },
      { text: "CRM with built-in email sequences", intent: "COMMERCIAL" as const, cluster: "Email", priority: 4, approved: true },
    ];
    const res = await savePromptReview(user.id, projectId, { prompts: items, deletedIds: toDelete, finish: true });
    expect(res.approved).toBe(items.length - 1);

    state = await getOnboardingState(user.id, projectId);
    expect(state.prompts).toHaveLength(28);
    expect(state.prompts.filter((p) => p.isActive && p.approvedAt)).toHaveLength(items.length - 1);
    expect(state.prompts.find((p) => p.id === edited!.id)!.text).toBe("Best CRM for seed-stage startups");
    expect(state.prompts.find((p) => p.text === "CRM with built-in email sequences")).toMatchObject({ source: "USER", country: "US", language: "en", isActive: true });
    // An explicitly unapproved prompt is remembered as reviewed (not reset to the "approve by default" state).
    expect(state.prompts.find((p) => p.id === pendingOne.id)).toMatchObject({ isActive: false, approvedAt: null, reviewedAt: expect.any(Date) });
    expect(state.prompts.filter((p) => p.reviewedAt === null)).toHaveLength(0);
    expect(state.project.onboardingStep).toBe("COMPLETED");
    expect(state.project.onboardingCompletedAt).not.toBeNull();

    const usage = await db.usageRecord.findMany({ where: { organizationId: org.id } });
    expect(usage.map((u) => u.metric).sort()).toEqual(["AI_EXTRACTION", "AI_EXTRACTION", "AI_EXTRACTION", "CRAWL_PAGE"]);
    const audit = await db.auditLog.findMany({ where: { organizationId: org.id }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["onboarding.analysis_completed", "onboarding.prompts_generated", "onboarding.completed"]));
  });

  it("resumes an unfinished project for the same domain, refuses a completed one", async () => {
    const { user, org } = await setup("resume@nw.com");
    const deps: OnboardingDeps = { llm: routedLLM(), crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const first = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    const again = await startOnboarding(user.id, org.id, { url: "https://northwind.com", ...market, country: "GB" }, deps);
    expect(again.projectId).toBe(first.projectId);
    expect(await db.websiteAnalysis.count({ where: { projectId: first.projectId } })).toBe(2); // history kept
    expect((await db.project.findUniqueOrThrow({ where: { id: first.projectId } })).country).toBe("GB");
    await db.project.update({ where: { id: first.projectId }, data: { onboardingCompletedAt: new Date() } });
    await expect(startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("onboarding fallbacks and failures", () => {
  it("records a failed analysis without throwing, keeping the user's project", async () => {
    const { user, org } = await setup("fail@nw.com");
    const deps: OnboardingDeps = { llm: null, crawl: async () => Promise.reject(new CrawlError("ROBOTS_DISALLOWED", "robots says no")) };
    const { projectId, analysis } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    expect(analysis).toMatchObject({ status: "FAILED", errorCode: "ROBOTS_DISALLOWED", errorMessage: "robots says no" });
    // The user can still enter the brand manually.
    await saveBrandProfile(user.id, projectId, { brandName: "Northwind", industry: "CRM software", description: "", products: [], services: [], targetCustomers: [], markets: [], topics: [], aliases: [] });
    expect((await getOnboardingState(user.id, projectId)).project.onboardingStep).toBe("COMPETITORS");
  });

  it("without AI: deterministic brand, no competitor guesses, 30 labelled template prompts", async () => {
    const { user, org } = await setup("noai@nw.com");
    const deps: OnboardingDeps = { llm: null, crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId, analysis } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    expect(analysis).toMatchObject({ status: "COMPLETED", method: "DETERMINISTIC", aiProvider: null });
    expect((await getOnboardingState(user.id, projectId)).brand).toMatchObject({ name: "Northwind", industry: null });

    // Prompt generation needs a category: blocked until the user fills in the brand profile.
    await expect(generatePrompts(user.id, projectId, deps)).rejects.toMatchObject({ code: "VALIDATION" });
    await saveBrandProfile(user.id, projectId, { brandName: "Northwind", industry: "CRM software", description: "", products: [], services: [], targetCustomers: [], markets: [], topics: [], aliases: [] });
    expect(await suggestCompetitors(user.id, projectId, deps)).toEqual({ method: "UNAVAILABLE", added: 0 });
    await saveCompetitors(user.id, projectId, [{ name: "HubSpot", domain: "hubspot.com" }, { name: "Pipedrive" }]);
    const gen = await generatePrompts(user.id, projectId, deps);
    expect(gen).toMatchObject({ method: "TEMPLATES", created: 30 });
    const prompts = await db.prompt.findMany({ where: { projectId } });
    expect(prompts.every((p) => p.source === "TEMPLATE")).toBe(true);
    expect(await db.usageRecord.count({ where: { organizationId: org.id, metric: "AI_EXTRACTION" } })).toBe(0);
  });

  it("falls back to deterministic extraction when AI output stays invalid, and records that", async () => {
    const { user, org } = await setup("bad-ai@nw.com");
    const llm = fakeLLM(() => ({ brandName: "" }));
    const deps: OnboardingDeps = { llm, crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { analysis } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    expect(llm.requests).toHaveLength(3);
    expect(analysis).toMatchObject({ status: "COMPLETED", method: "DETERMINISTIC", aiAttempts: 3 });
    expect(analysis.extraction).toMatchObject({ aiError: "INVALID_OUTPUT" });
    expect(await db.usageRecord.count({ where: { organizationId: org.id, metric: "AI_EXTRACTION" } })).toBe(1);
  });

  it("does not regenerate competitors on provider failure and reports UNAVAILABLE", async () => {
    const { user, org } = await setup("fatal@nw.com");
    const llm = fakeLLM((req) => (req.schemaName === "brand_profile" ? brandJson : new LLMError("FATAL", "401", 401)));
    const deps: OnboardingDeps = { llm, crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    expect(await suggestCompetitors(user.id, projectId, deps)).toEqual({ method: "UNAVAILABLE", added: 0 });
  });
});

describe("onboarding authorization and validation", () => {
  it("isolates organizations on every step", async () => {
    const { user, org } = await setup("a@nw.com");
    const mallory = await db.user.create({ data: { email: "m@evil.com" } });
    const deps: OnboardingDeps = { llm: routedLLM(), crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);

    const notFound = (p: Promise<unknown>) => expect(p).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
    await notFound(startOnboarding(mallory.id, org.id, { url: "evil.com", ...market }, deps));
    await notFound(runWebsiteAnalysis(mallory.id, projectId, deps));
    await notFound(getOnboardingState(mallory.id, projectId));
    await notFound(saveBrandProfile(mallory.id, projectId, { ...brandJson, aliases: [] }));
    await notFound(suggestCompetitors(mallory.id, projectId, deps));
    await notFound(saveCompetitors(mallory.id, projectId, []));
    await notFound(generatePrompts(mallory.id, projectId, deps));
    await notFound(savePromptReview(mallory.id, projectId, { prompts: [], deletedIds: [] }));
  });

  it("rejects prompt ids from another project", async () => {
    const { user, org } = await setup("ids@nw.com");
    const deps: OnboardingDeps = { llm: routedLLM(), crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const a = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    const b = await startOnboarding(user.id, org.id, { url: "southwind.com", ...market }, deps);
    const otherPrompt = await db.prompt.create({ data: { projectId: b.projectId, text: "B prompt", intent: "COMMERCIAL", country: "US", language: "en" } });
    await expect(
      savePromptReview(user.id, a.projectId, { prompts: [{ id: otherPrompt.id, text: "hijack", intent: "COMMERCIAL", cluster: "x", priority: 3, approved: true }] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(savePromptReview(user.id, a.projectId, { prompts: [], deletedIds: [otherPrompt.id] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await db.prompt.findUniqueOrThrow({ where: { id: otherPrompt.id } })).text).toBe("B prompt");
  });

  it("validates competitor input and blocks unsafe or self domains", async () => {
    const { user, org } = await setup("val@nw.com");
    const deps: OnboardingDeps = { llm: routedLLM(), crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    await expect(saveCompetitors(user.id, projectId, [{ name: "Internal", domain: "http://169.254.169.254" }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveCompetitors(user.id, projectId, [{ name: "Me", domain: "northwind.com" }])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(saveCompetitors(user.id, projectId, [{ name: "A" }, { name: "a" }])).rejects.toThrow();
    await expect(saveCompetitors(user.id, projectId, Array.from({ length: 11 }, (_, i) => ({ name: `C${i}` })))).rejects.toThrow();
  });

  it("requires at least one approved prompt to finish and rejects duplicate texts", async () => {
    const { user, org } = await setup("fin@nw.com");
    const deps: OnboardingDeps = { llm: routedLLM(), crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId } = await startOnboarding(user.id, org.id, { url: "northwind.com", ...market }, deps);
    const item = { text: "Best CRM", intent: "COMMERCIAL" as const, cluster: "CRM", priority: 3 };
    await expect(savePromptReview(user.id, projectId, { prompts: [{ ...item, approved: false }], finish: true })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(savePromptReview(user.id, projectId, { prompts: [{ ...item, approved: true }, { ...item, text: "best crm", approved: true }] })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("onboarding review fixes", () => {
  it("does not create a project when the analysis rate limit is hit", async () => {
    const { user, org } = await setup("limit@nw.com");
    const deps: OnboardingDeps = { llm: null, crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    for (let i = 0; i < 30; i++) await db.websiteAnalysis.create({ data: { project: { create: { organizationId: org.id, name: `p${i}`, domain: `p${i}.com`, country: "US", language: "en", locale: "en-US" } }, requestedUrl: "x" } });
    const before = await db.project.count({ where: { organizationId: org.id } });
    await expect(startOnboarding(user.id, org.id, { url: "fresh-domain.com", ...market }, deps)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await db.project.count({ where: { organizationId: org.id } })).toBe(before);
  });

  it("marks analyses stuck in RUNNING as failed when state is read", async () => {
    const { user, org } = await setup("stale@nw.com");
    const deps: OnboardingDeps = { llm: null, crawl: async (url) => fakeCrawl(new URL(url).hostname) };
    const { projectId } = await startOnboarding(user.id, org.id, { url: "stale.com", ...market }, deps);
    await db.websiteAnalysis.create({ data: { projectId, requestedUrl: "x", status: "RUNNING", createdAt: new Date(Date.now() - 11 * 60 * 1000) } });
    const state = await getOnboardingState(user.id, projectId);
    expect(await db.websiteAnalysis.count({ where: { projectId, status: "RUNNING" } })).toBe(0);
    expect(state.analysis).toBeTruthy();
  });
});
