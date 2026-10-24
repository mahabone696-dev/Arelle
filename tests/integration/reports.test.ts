import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { createShareLink, hashToken, listShareLinks, resolveShare, revokeShareLink } from "@/server/reports/service";
import type { PlanTier } from "@/generated/prisma/enums";
import { seedDemoScans } from "../../prisma/demo-data";

async function setup(tier: PlanTier = "AGENCY", withData = false) {
  const user = await db.user.create({ data: { email: `r${Math.random()}@t.com` } });
  const org = await createOrganization(user.id, { name: "Report Co" });
  await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: tier } });
  const project = await db.project.create({ data: { organizationId: org.id, name: "Northwind CRM", domain: `nw${Math.floor(Math.random() * 1e9)}.example`, country: "US", language: "en", locale: "en-US" } });
  if (withData) {
    for (const slug of ["openai", "gemini", "perplexity"]) await db.aIProvider.upsert({ where: { slug }, create: { slug, displayName: slug }, update: {} });
    await db.brand.create({ data: { projectId: project.id, name: "Northwind CRM", domain: project.domain } });
    for (const [name, domain] of [["HubSpot", "hubspot.com"], ["Salesforce", "salesforce.com"]]) await db.competitor.create({ data: { projectId: project.id, name: name!, domain } });
    for (const text of ["Best CRM software", "Best CRM for startups", "HubSpot alternatives"]) await db.prompt.create({ data: { projectId: project.id, text, intent: "COMMERCIAL", priority: 5, country: "US", language: "en", isActive: true, approvedAt: new Date() } });
    await db.organization.update({ where: { id: org.id }, data: { isDemo: true } });
    await seedDemoScans(db as never, project.id);
  }
  return { user, org, project };
}

describe("shareable reports", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    process.env.FEATURE_REPORTS = "true";
    ctx = await setup("AGENCY", true);
  }, 60_000);

  it("a share link is shown once, stored hashed, and resolves to the full report", async () => {
    const link = await createShareLink(ctx.user.id, ctx.project.id, { title: "October", range: "90d", expiresInDays: "30", agencyName: "Acme Agency", accentColor: "#2A78D6" });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await db.reportShare.findUniqueOrThrow({ where: { id: link.id } });
    expect(stored.tokenHash).toBe(hashToken(link.token));
    expect(JSON.stringify(stored)).not.toContain(link.token);
    expect(stored).toMatchObject({ range: "90d", branding: { agencyName: "Acme Agency", accentColor: "#2a78d6" } });

    const res = await resolveShare(link.token);
    if (!res.ok) throw new Error(res.reason);
    expect(res.title).toBe("October");
    const r = res.report;
    expect(r.primary?.visibilityScore).toBeGreaterThan(0);
    expect(r.series.length).toBeGreaterThan(1);
    expect(r.competitors.map((c) => c.name)).toEqual(expect.arrayContaining(["Northwind CRM", "HubSpot", "Salesforce"]));
    expect(r.winning.length + r.losing.length).toBeGreaterThan(0);
    expect(r.actionsCompleted.length).toBe(1); // the demo history implements one recommendation
    expect((await db.reportShare.findUniqueOrThrow({ where: { id: link.id } })).viewCount).toBe(1);
  });

  it("expired, revoked, malformed and unknown links don't resolve; a downgrade pauses links", async () => {
    const now = new Date();
    const short = await createShareLink(ctx.user.id, ctx.project.id, { expiresInDays: "7" }, now);
    expect(await resolveShare(short.token, new Date(now.getTime() + 8 * 86_400_000))).toEqual({ ok: false, reason: "EXPIRED" });
    const never = await createShareLink(ctx.user.id, ctx.project.id, { expiresInDays: "0" });
    expect(never.expiresAt).toBeNull();
    await revokeShareLink(ctx.user.id, ctx.project.id, never.id);
    expect(await resolveShare(never.token)).toEqual({ ok: false, reason: "REVOKED" });
    expect(await resolveShare("short")).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await resolveShare("x".repeat(43))).toEqual({ ok: false, reason: "NOT_FOUND" });

    const live = await createShareLink(ctx.user.id, ctx.project.id, {});
    await db.subscription.update({ where: { organizationId: ctx.org.id }, data: { status: "CANCELED" } });
    expect(await resolveShare(live.token)).toEqual({ ok: false, reason: "PLAN" });
    await db.subscription.update({ where: { organizationId: ctx.org.id }, data: { status: "ACTIVE" } });
    expect((await resolveShare(live.token)).ok).toBe(true);

    // The feature flag is an off switch for every link.
    process.env.FEATURE_REPORTS = "false";
    expect(await resolveShare(live.token)).toEqual({ ok: false, reason: "PLAN" });
    await expect(createShareLink(ctx.user.id, ctx.project.id, {})).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    process.env.FEATURE_REPORTS = "true";

    const { links } = await listShareLinks(ctx.user.id, ctx.project.id);
    expect(links.map((l) => l.status).sort()).toEqual(["ACTIVE", "ACTIVE", "REVOKED"]);
  });

  it("validates input; requires the Agency plan and share permission; isolates organizations", async () => {
    await expect(createShareLink(ctx.user.id, ctx.project.id, { accentColor: "red" })).rejects.toThrow();
    await expect(createShareLink(ctx.user.id, ctx.project.id, { expiresInDays: "5" })).rejects.toThrow();

    const growth = await setup("GROWTH");
    await expect(createShareLink(growth.user.id, growth.project.id, {})).rejects.toMatchObject({ code: "FEATURE_DISABLED", details: { needed: "AGENCY" } });
    expect((await listShareLinks(growth.user.id, growth.project.id)).entitled).toBe(false);

    const viewer = await db.user.create({ data: { email: `v${Math.random()}@t.com` } });
    await db.organizationMember.create({ data: { organizationId: ctx.org.id, userId: viewer.id, role: "VIEWER" } });
    await expect(createShareLink(viewer.id, ctx.project.id, {})).rejects.toMatchObject({ code: "FORBIDDEN" });

    const other = await setup("AGENCY");
    const mine = await createShareLink(ctx.user.id, ctx.project.id, {});
    await expect(createShareLink(other.user.id, ctx.project.id, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(revokeShareLink(other.user.id, other.project.id, mine.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await resolveShare(mine.token)).ok).toBe(true);
  });
});
