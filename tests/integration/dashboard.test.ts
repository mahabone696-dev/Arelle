import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { getCitationsView, getCompetitorsView, getOverview, getPromptDetail, getPromptsTable } from "@/server/dashboard/metrics";
import { seedDemoScans } from "../../prisma/demo-data";

async function setup(isDemo = true) {
  for (const slug of ["openai", "gemini", "perplexity"]) await db.aIProvider.create({ data: { slug, displayName: slug === "openai" ? "ChatGPT" : slug[0]!.toUpperCase() + slug.slice(1) } });
  const user = await db.user.create({ data: { email: `d${Math.random()}@t.com` } });
  const org = await createOrganization(user.id, { name: "Dash Co" });
  await db.organization.update({ where: { id: org.id }, data: { isDemo } });
  const project = await db.project.create({ data: { organizationId: org.id, name: "Northwind CRM", domain: "demo-crm.example", country: "US", language: "en", locale: "en-US" } });
  await db.brand.create({ data: { projectId: project.id, name: "Northwind CRM", domain: "demo-crm.example" } });
  for (const [name, domain] of [["HubSpot", "hubspot.com"], ["Salesforce", "salesforce.com"], ["Pipedrive", "pipedrive.com"]]) await db.competitor.create({ data: { projectId: project.id, name: name!, domain } });
  for (const text of ["Best CRM software", "Best CRM for startups", "HubSpot alternatives"]) await db.prompt.create({ data: { projectId: project.id, text, intent: "COMMERCIAL", country: "US", language: "en", isActive: true, approvedAt: new Date() } });
  await seedDemoScans(db as never, project.id);
  return { user, org, project };
}

describe("dashboard metrics on demo history", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  }, 60_000);

  it("overview: 7-day score equals the latest scan's stored snapshot exactly", async () => {
    const o = await getOverview(ctx.user.id, ctx.project.id, "7d");
    const latestScan = await db.scan.findFirstOrThrow({ where: { projectId: ctx.project.id }, orderBy: { completedAt: "desc" } });
    const snap = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: latestScan.id, providerId: null, competitorId: null } });
    expect(o.answers).toBe(9); // 3 prompts × 3 engines in the latest weekly scan
    expect(o.primary!.visibilityScore).toBe(snap.visibilityScore);
    expect(o.primary!.mentionRate).toBe(snap.mentionRate);
    expect(o.primary!.shareOfVoice).toBe(snap.shareOfVoice);
    // Previous 7 days hold the scan before → a delta exists
    expect(o.primary!.deltas?.visibilityScore).not.toBeNull();
    // Each engine's score equals its per-provider snapshot
    for (const e of o.engines) {
      const s = await db.visibilitySnapshot.findFirstOrThrow({ where: { scanId: latestScan.id, providerId: e.providerId, competitorId: null } });
      expect(e.score).toBe(s.visibilityScore);
    }
  });

  it("overview over 90 days: full history, trend points per weekly scan, competitors ranked", async () => {
    const o = await getOverview(ctx.user.id, ctx.project.id, "90d");
    expect(o.answers).toBe(8 * 9);
    expect(o.series).toHaveLength(8);
    expect(o.competitorTable.map((r) => r.name)).toEqual(expect.arrayContaining(["Northwind CRM", "HubSpot", "Salesforce", "Pipedrive"]));
    const scores = o.competitorTable.map((r) => r.metrics.visibilityScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("prompts table, filters and prompt detail", async () => {
    const t = await getPromptsTable(ctx.user.id, ctx.project.id, "90d");
    expect(t.rows).toHaveLength(3);
    expect(t.providers.map((p) => p.displayName).sort()).toEqual(["ChatGPT", "Gemini", "Perplexity"]);
    for (const r of t.rows) expect(Object.keys(r.perProvider)).toHaveLength(3);
    expect((await getPromptsTable(ctx.user.id, ctx.project.id, "90d", { q: "alternatives" })).rows.map((r) => r.text)).toEqual(["HubSpot alternatives"]);
    const losing = (await getPromptsTable(ctx.user.id, ctx.project.id, "90d", { status: "LOSING" })).rows;
    expect(losing.every((r) => r.status === "LOSING")).toBe(true);
    const gemini = t.providers.find((p) => p.displayName === "Gemini")!;
    const onlyGemini = await getPromptsTable(ctx.user.id, ctx.project.id, "90d", { providerId: gemini.id });
    for (const r of onlyGemini.rows) expect(Object.keys(r.perProvider)).toEqual([gemini.id]);

    const d = await getPromptDetail(ctx.user.id, ctx.project.id, t.rows[0]!.id, "90d");
    expect(d.answers).toBe(24);
    expect(d.latest).toHaveLength(3);
    expect(d.latest.every((a) => a.response.normalizedText.startsWith("[DEMO DATA]"))).toBe(true);
    expect(d.ranking.some((r) => r.isPrimary)).toBe(true);
  });

  it("competitors and citations views", async () => {
    const c = await getCompetitorsView(ctx.user.id, ctx.project.id, "90d");
    expect(c.rows[0]).toMatchObject({ isPrimary: true, name: "Northwind CRM" });
    expect(c.wins).toHaveLength(3);
    const cit = await getCitationsView(ctx.user.id, ctx.project.id, "90d");
    expect(cit.totalCitations).toBe(cit.domains.reduce((n, d) => n + d.citations, 0));
    expect(cit.gaps.every((g) => g.ownerType === "THIRD_PARTY" && g.gapScore! > 0)).toBe(true);
    expect(cit.domains.find((d) => d.domain === "demo-crm.example")?.ownerType ?? "PRIMARY").toBe("PRIMARY");
  });

  it("isolates organizations and never shows demo answers in a real workspace", async () => {
    const mallory = await db.user.create({ data: { email: "m@evil.com" } });
    for (const fn of [getOverview, getCompetitorsView, getCitationsView] as const) await expect(fn(mallory.id, ctx.project.id, "90d")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getPromptsTable(mallory.id, ctx.project.id, "90d")).rejects.toMatchObject({ code: "NOT_FOUND" });
    const promptId = (await db.prompt.findFirstOrThrow({ where: { projectId: ctx.project.id } })).id;
    await expect(getPromptDetail(mallory.id, ctx.project.id, promptId, "90d")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Same data, but the workspace is flagged real: demo answers must not count.
    await db.organization.update({ where: { id: ctx.org.id }, data: { isDemo: false } });
    expect((await getOverview(ctx.user.id, ctx.project.id, "90d")).answers).toBe(0);
  });

  it("prompt ids from another project 404", async () => {
    const other = await db.project.create({ data: { organizationId: ctx.org.id, name: "Other", domain: "other.com", country: "US", language: "en", locale: "en-US" } });
    const p = await db.prompt.create({ data: { projectId: other.id, text: "x", intent: "COMMERCIAL", country: "US", language: "en" } });
    await expect(getPromptDetail(ctx.user.id, ctx.project.id, p.id, "90d")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
