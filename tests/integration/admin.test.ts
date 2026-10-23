import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { adminFailures, adminOrganizations, adminOverview, adminScans, adminSetKillSwitch, adminSetProviderEnabled, adminUsers } from "@/server/admin/service";
import { getScanKillSwitch } from "@/server/system/settings";
import { createOrganization } from "@/server/organizations/service";

async function fixture() {
  const admin = await db.user.create({ data: { email: "ops@t.com", isPlatformAdmin: true } });
  const member = await db.user.create({ data: { email: "member@t.com" } });
  const org = await createOrganization(member.id, { name: "Paying Co" });
  await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: "GROWTH", status: "ACTIVE" } });
  const demoOrg = await db.organization.create({ data: { name: "Demo", slug: "demo-x", isDemo: true } });
  const provider = await db.aIProvider.create({ data: { slug: "openai", displayName: "ChatGPT", isEnabled: true } });
  const mk = async (orgId: string, domain: string, isDemo: boolean, cost: number, jobStatus: "SUCCEEDED" | "FAILED") => {
    const project = await db.project.create({ data: { organizationId: orgId, name: domain, domain, country: "US", language: "en", locale: "en-US" } });
    const prompt = await db.prompt.create({ data: { projectId: project.id, text: "Best CRM", intent: "COMMERCIAL", country: "US", language: "en" } });
    const scan = await db.scan.create({ data: { projectId: project.id, expectedQueryCount: 1, isDemo, status: jobStatus === "FAILED" ? "FAILED" : "COMPLETED" } });
    const job = await db.scanJob.create({ data: { scanId: scan.id, promptId: prompt.id, providerId: provider.id, country: "US", language: "en", status: jobStatus, errorCode: jobStatus === "FAILED" ? "RATE_LIMITED" : null } });
    if (jobStatus === "SUCCEEDED") await db.aIResponse.create({ data: { scanId: scan.id, scanJobId: job.id, promptId: prompt.id, providerId: provider.id, model: "m", country: "US", language: "en", promptText: "Best CRM", rawText: "x", normalizedText: "x", latencyMs: 1, inputTokens: 10, outputTokens: 5, estimatedCost: cost, isDemo } });
    return scan;
  };
  await mk(org.id, "real.com", false, 0.25, "SUCCEEDED");
  await mk(org.id, "broken.com", false, 0, "FAILED");
  await mk(demoOrg.id, "demo.com", true, 99, "SUCCEEDED");
  await db.publicAudit.create({ data: { domain: "lead.com", ipHash: "h", status: "COMPLETED", result: { costUsd: 0.01 }, convertedTo: `user:${member.id}` } });
  return { admin, member, org };
}

describe("platform admin", () => {
  it("is invisible to non-admins", async () => {
    const { member } = await fixture();
    for (const call of [adminOverview, adminOrganizations, adminUsers, adminScans, adminFailures]) await expect(call(member.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adminSetKillSwitch(member.id, { enabled: "true", reason: "x" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adminSetProviderEnabled(member.id, "openai", false)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await getScanKillSwitch()).enabled).toBe(false);
  });

  it("reports usage, costs, subscriptions and failures without demo data", async () => {
    const { admin } = await fixture();
    const o = await adminOverview(admin.id);
    expect(o.counts.orgs).toBe(1);
    expect(o.paying).toBe(1);
    const openai = o.providers.find((p) => p.slug === "openai")!;
    expect(openai.answers30d).toBe(1);
    expect(openai.cost30d).toBeCloseTo(0.25);
    expect(openai.tokens30d).toBe(15);
    expect(o.costs.scans30d).toBeCloseTo(0.25);
    expect(o.costs.audits30d).toBeCloseTo(0.01);
    expect(o.costs.daily.reduce((s, d) => s + d.cost, 0)).toBeCloseTo(0.25);
    expect(o.audits).toMatchObject({ byStatus: { COMPLETED: 1 }, conversions30d: 1 });
    expect(o.counts.failedJobs24h).toBe(1);
    expect(o.subscriptions).toEqual([expect.objectContaining({ tier: "GROWTH", status: "ACTIVE", effective: "GROWTH", count: 1 })]);

    const f = await adminFailures(admin.id);
    expect(f.jobs).toHaveLength(1);
    expect(f.byCode).toEqual([{ code: "RATE_LIMITED", count: 1 }]);
    expect((await adminScans(admin.id, "broken")).map((s) => s.project.domain)).toEqual(["broken.com"]);
    expect((await adminUsers(admin.id, "MEMBER@")).map((u) => u.email)).toEqual(["member@t.com"]);
    expect((await adminOrganizations(admin.id)).map((x) => x.effective).sort()).toEqual(["FREE", "GROWTH"]);
  });

  it("toggles the kill switch (reason required) and providers, with audit logs", async () => {
    const { admin } = await fixture();
    await expect(adminSetKillSwitch(admin.id, { enabled: "true" })).rejects.toMatchObject({ code: "VALIDATION" });
    await adminSetKillSwitch(admin.id, { enabled: "true", reason: "provider incident" });
    expect(await getScanKillSwitch()).toEqual({ enabled: true, reason: "provider incident" });
    await adminSetKillSwitch(admin.id, { enabled: "false" });
    expect((await getScanKillSwitch()).enabled).toBe(false);

    await adminSetProviderEnabled(admin.id, "openai", false);
    expect((await db.aIProvider.findUniqueOrThrow({ where: { slug: "openai" } })).isEnabled).toBe(false);
    await expect(adminSetProviderEnabled(admin.id, "nope", true)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const actions = (await db.auditLog.findMany({ where: { actorId: admin.id }, select: { action: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["system.kill_switch.on", "system.kill_switch.off", "provider.disabled"]));
  });
});
