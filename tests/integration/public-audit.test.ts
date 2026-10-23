import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db";
import { AUDIT_LIMITS, checkFormToken, getPublicAudit, issueFormToken, markAuditConverted, requestAudit, runAudit, type AuditDeps, type AuditRunDeps } from "@/server/audit/service";
import { setScanKillSwitch } from "@/server/system/settings";
import type { ReadyProvider } from "@/server/providers/registry";
import type { CrawlResult } from "@/server/crawler/crawler";

const ANSWERS: Record<string, string> = {
  default: "The best options are HubSpot and Salesforce. Northwind CRM is also popular with small teams. See https://g2.com/crm for reviews.",
  lost: "Most teams pick HubSpot or Salesforce. Details: https://capterra.com/crm and https://g2.com/crm.",
};

function fakeProvider(answer: (prompt: string) => string): ReadyProvider {
  return {
    providerId: "p1",
    slug: "openai",
    displayName: "ChatGPT",
    maxConcurrency: 1,
    requestsPerMinute: 60,
    dailyQueryCap: 100,
    modelRowId: "m1",
    modelId: "test-model",
    adapter: {
      providerName: "openai",
      model: "test-model",
      capabilities: { citations: true, webSearch: true, location: true },
      healthCheck: async () => true,
      estimateCost: async () => 0.01,
      query: vi.fn(async ({ prompt }) => {
        const text = answer(prompt);
        return { rawText: text, normalizedText: text, citations: [], model: "test-model", latencyMs: 5, tokenUsage: { input: 10, output: 20, total: 30 }, estimatedCost: 0.002, metadata: {} };
      }),
    },
  };
}

const crawl: CrawlResult = {
  requestedUrl: "https://northwindcrm.com/",
  site: "northwindcrm.com",
  homepageUrl: "https://northwindcrm.com/",
  robots: { status: "ALLOWED" as never, homepageOnly: false },
  sitemapUrlCount: 0,
  pages: [
    {
      url: "https://northwindcrm.com/",
      title: "Northwind CRM — CRM software for small teams",
      description: "Northwind CRM is simple CRM software for small sales teams.",
      siteName: "Northwind CRM",
      headings: { h1: ["CRM software for small teams"], h2: ["Pipeline management", "Email tracking"], h3: [] },
      text: "Northwind CRM helps small sales teams manage their pipeline. CRM software with email tracking and reporting.",
      wordCount: 20,
      links: [],
      jsonLd: [],
    },
  ],
  failures: [],
  stats: { requests: 1, bytes: 1000, durationMs: 10 },
};

const past = () => issueFormToken(Date.now() - 5_000);
const enqueue = vi.fn(async () => {});
const deps = (ready: ReadyProvider[] = [fakeProvider(() => ANSWERS.default!)]): AuditDeps => ({ enqueue, availability: async () => ({ ready }) });
let ipN = 0;
const ip = () => `203.0.113.${++ipN}`;

beforeEach(() => {
  process.env.FEATURE_PUBLIC_AUDIT = "true";
  delete process.env.PUBLIC_AUDIT_DAILY_CAP;
  enqueue.mockClear();
});

describe("public audit: request protection", () => {
  it("form tokens: signed, not instant, not stale", () => {
    const now = Date.now();
    expect(checkFormToken(issueFormToken(now - 5_000), now)).toBe("ok");
    expect(checkFormToken(issueFormToken(now), now)).toBe("too_fast");
    expect(checkFormToken(issueFormToken(now - 3 * 3_600_000), now)).toBe("expired");
    expect(checkFormToken(`${now - 5000}.forged`, now)).toBe("invalid");
    expect(checkFormToken(undefined, now)).toBe("invalid");
  });

  it("rejects bots, bad domains, a disabled flag and the kill switch; queues a valid request", async () => {
    await expect(requestAudit({ domain: "northwindcrm.com", website: "spam", formToken: past() }, ip(), deps())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(requestAudit({ domain: "northwindcrm.com", formToken: issueFormToken() }, ip(), deps())).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(requestAudit({ domain: "localhost", formToken: past() }, ip(), deps())).rejects.toMatchObject({ code: "VALIDATION" });
    expect(enqueue).not.toHaveBeenCalled();

    process.env.FEATURE_PUBLIC_AUDIT = "false";
    await expect(requestAudit({ domain: "northwindcrm.com", formToken: past() }, ip(), deps())).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    process.env.FEATURE_PUBLIC_AUDIT = "true";

    await setScanKillSwitch({ enabled: true, reason: "incident" }, "test");
    await expect(requestAudit({ domain: "northwindcrm.com", formToken: past() }, ip(), deps())).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await setScanKillSwitch({ enabled: false }, "test");

    await expect(requestAudit({ domain: "northwindcrm.com", formToken: past() }, ip(), deps([]))).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const ok = await requestAudit({ domain: "https://www.NorthwindCRM.com/pricing", country: "gb", formToken: past() }, ip(), deps());
    expect(ok.cached).toBe(false);
    expect(enqueue).toHaveBeenCalledWith(ok.auditId);
    const row = await db.publicAudit.findUniqueOrThrow({ where: { id: ok.auditId } });
    expect(row).toMatchObject({ domain: "northwindcrm.com", status: "PENDING", result: { country: "GB" } });
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ipHash).not.toContain("203.0.113");
  });

  it("reuses a recent audit of the same domain, and limits per IP and per day", async () => {
    const me = ip();
    const first = await requestAudit({ domain: "alpha-test.com", formToken: past() }, me, deps());
    const again = await requestAudit({ domain: "alpha-test.com", formToken: past() }, ip(), deps());
    expect(again).toEqual({ auditId: first.auditId, cached: true });
    expect(enqueue).toHaveBeenCalledTimes(1);

    for (let i = 1; i < AUDIT_LIMITS.perIpHour; i++) await requestAudit({ domain: `beta${i}-test.com`, formToken: past() }, me, deps());
    await expect(requestAudit({ domain: "gamma-test.com", formToken: past() }, me, deps())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(await db.publicAudit.count({ where: { status: "RATE_LIMITED" } })).toBe(1);
    // A cached domain still answers for a limited IP: it costs nothing.
    expect((await requestAudit({ domain: "alpha-test.com", formToken: past() }, me, deps())).cached).toBe(true);

    process.env.PUBLIC_AUDIT_DAILY_CAP = String(AUDIT_LIMITS.perIpHour);
    await expect(requestAudit({ domain: "delta-test.com", formToken: past() }, ip(), deps())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("public audit: run", () => {
  async function queued(domain = "northwindcrm.com") {
    return db.publicAudit.create({ data: { domain, ipHash: "h", status: "PENDING", result: { country: "US" } } });
  }
  const run = (provider: ReadyProvider, over: Partial<AuditRunDeps> = {}): AuditRunDeps => ({ llm: null, availability: async () => ({ ready: [provider] }), crawl: async () => crawl, ...over });

  it("scores visibility from real answers and exposes counts only", async () => {
    const audit = await queued();
    const provider = fakeProvider((p) => (/alternative|vs|compare/i.test(p) ? ANSWERS.lost! : ANSWERS.default!));
    await runAudit(audit.id, run(provider));
    const row = await db.publicAudit.findUniqueOrThrow({ where: { id: audit.id } });
    expect(row.status, JSON.stringify(row.result)).toBe("COMPLETED");
    const calls = (provider.adapter.query as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(AUDIT_LIMITS.prompts);

    const view = await getPublicAudit(audit.id);
    const r = view!.result!;
    expect(r.brand.name).toBe("Northwind CRM");
    expect(r.prompts.length).toBe(calls);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.engine).toMatchObject({ slug: "openai", localized: true });
    expect(r.teaser.lostPrompts).toBe(r.prompts.filter((p) => !p.mentioned).length);
    // Locked details and cost never reach the public page.
    expect(r).not.toHaveProperty("locked");
    expect(r).not.toHaveProperty("costUsd");
    expect((row.result as { locked: unknown }).locked).toBeDefined();

    // Runs once: a duplicate job is a no-op.
    await runAudit(audit.id, run(provider));
    expect((provider.adapter.query as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it("fails transparently: unreadable site, no engine, kill switch", async () => {
    const a = await queued("alpha-test.com");
    await runAudit(a.id, run(fakeProvider(() => "x"), { crawl: async () => ({ ...crawl, pages: [] }) }));
    expect(await getPublicAudit(a.id)).toMatchObject({ status: "FAILED", error: expect.stringContaining("couldn't read") });

    const b = await queued("beta-test.com");
    await runAudit(b.id, run(fakeProvider(() => "x"), { availability: async () => ({ ready: [] }) }));
    expect(await getPublicAudit(b.id)).toMatchObject({ status: "FAILED", error: "No AI engine is available." });

    const c = await queued("gamma-test.com");
    await setScanKillSwitch({ enabled: true }, "test");
    const p = fakeProvider(() => "x");
    await runAudit(c.id, run(p));
    expect(await getPublicAudit(c.id)).toMatchObject({ status: "FAILED" });
    expect(p.adapter.query).not.toHaveBeenCalled();
  });

  it("uses the onboarding model for brand and competitors when available", async () => {
    const audit = await queued();
    const llm = {
      provider: "openai",
      model: "test",
      complete: vi.fn(async (req: { schemaName: string }) => ({
        model: "test",
        latencyMs: 1,
        inputTokens: 100,
        outputTokens: 50,
        text: JSON.stringify(
          req.schemaName === "brand_profile"
            ? { brandName: "Northwind CRM", description: "CRM for small teams", industry: "CRM software", products: [], services: [], targetCustomers: ["small businesses"], markets: [], topics: [] }
            : { competitors: [{ name: "HubSpot", domain: "hubspot.com", reason: "CRM", confidence: 0.9 }, { name: "Salesforce", domain: "salesforce.com", reason: "CRM", confidence: 0.8 }] },
        ),
      })),
    };
    const provider = fakeProvider((p) => (/vs/i.test(p) ? ANSWERS.lost! : ANSWERS.default!));
    await runAudit(audit.id, run(provider, { llm }));
    const r = (await getPublicAudit(audit.id))!.result!;
    expect(r.competitors.map((c) => c.name).sort()).toEqual(["HubSpot", "Salesforce"]);
    expect(r.competitors[0]!.score).toBeGreaterThan(0);
    expect(r.prompts.every((p) => !p.text.includes("for small teams for"))).toBe(true);
    expect(r.teaser.lostPrompts).toBe(r.prompts.filter((p) => !p.mentioned).length);
    if (r.teaser.lostPrompts) expect(r.teaser.recommendedActions).toBeGreaterThan(0);
    const stored = (await db.publicAudit.findUniqueOrThrow({ where: { id: audit.id } })).result as { llmTokens: number; costUsd: number };
    expect(stored.llmTokens).toBe(300);
    expect(stored.costUsd).toBeCloseTo(0.002 * r.prompts.length, 6);
  });

  it("records the sign-up conversion once", async () => {
    const audit = await queued();
    const user = await db.user.create({ data: { email: `c${Math.random()}@t.com` } });
    expect(await markAuditConverted(audit.id, user.id)).toBe("northwindcrm.com");
    await markAuditConverted(audit.id, "someone-else");
    expect((await db.publicAudit.findUniqueOrThrow({ where: { id: audit.id } })).convertedTo).toBe(`user:${user.id}`);
    expect(await markAuditConverted("../etc", user.id)).toBeNull();
    expect(await getPublicAudit("nope")).toBeNull();
  });
});
