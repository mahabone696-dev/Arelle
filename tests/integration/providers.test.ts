import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { getProviderAvailability } from "@/server/providers/registry";

async function seed() {
  const rows = [
    { slug: "openai", model: "gpt-4.1-mini", prices: [0.4, 1.6, 0.025] },
    { slug: "gemini", model: "gemini-3.8-flash", prices: [0.75, 3.75, 0.014] },
    { slug: "perplexity", model: "perplexity/sonar", prices: [0.25, 2.5, 0.0025] },
  ];
  for (const r of rows) {
    const p = await db.aIProvider.create({ data: { slug: r.slug, displayName: r.slug, isEnabled: true } });
    await db.aIModel.create({ data: { providerId: p.id, modelId: r.model, displayName: r.model, inputCostPer1M: r.prices[0]!, outputCostPer1M: r.prices[1]!, requestCost: r.prices[2]!, isDefault: true } });
  }
  // The retired Sonar chat-completions model is kept for history but never used.
  const pplx = await db.aIProvider.findUniqueOrThrow({ where: { slug: "perplexity" } });
  await db.aIModel.create({ data: { providerId: pplx.id, modelId: "sonar", displayName: "Sonar (legacy)", inputCostPer1M: 1, outputCostPer1M: 1, requestCost: 0.005, isActive: false } });
}

const KEYS = { OPENAI_API_KEY: "sk", GEMINI_API_KEY: "gm", PERPLEXITY_API_KEY: "pp" };
const env = (vars: Record<string, string>) => ({ NODE_ENV: "test", ...vars }) as NodeJS.ProcessEnv;

async function withFlags<T>(flags: Record<string, string>, fn: () => Promise<T>) {
  const prev = Object.fromEntries(Object.keys(flags).map((k) => [k, process.env[k]]));
  Object.assign(process.env, flags);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

describe("provider registry (phase 7)", () => {
  it("each engine needs its key, its feature flag and the admin switch; reasons are transparent", async () => {
    await seed();
    const off = await withFlags({ FEATURE_GEMINI: "false", FEATURE_PERPLEXITY: "false" }, () => getProviderAvailability(env({ ...KEYS })));
    expect(off.ready.map((p) => p.slug)).toEqual(["openai"]);
    expect(off.unavailable.map((u) => [u.slug, u.reason])).toEqual([["gemini", "FEATURE_OFF"], ["perplexity", "FEATURE_OFF"]]);

    const on = await withFlags({ FEATURE_GEMINI: "true", FEATURE_PERPLEXITY: "true" }, () => getProviderAvailability(env({ OPENAI_API_KEY: "sk", GEMINI_API_KEY: "gm" })));
    expect(on.ready.map((p) => [p.slug, p.modelId, p.adapter.capabilities.location])).toEqual([["openai", "gpt-4.1-mini", true], ["gemini", "gemini-3.8-flash", false]]);
    expect(on.unavailable).toEqual([expect.objectContaining({ slug: "perplexity", reason: "NOT_CONFIGURED" })]);

    const all = await withFlags({ FEATURE_GEMINI: "true", FEATURE_PERPLEXITY: "true" }, () => getProviderAvailability(env({ ...KEYS })));
    expect(all.ready.map((p) => [p.slug, p.modelId])).toEqual([["openai", "gpt-4.1-mini"], ["gemini", "gemini-3.8-flash"], ["perplexity", "perplexity/sonar"]]);

    // A model without pricing never runs (cost safety), and an admin switch-off wins.
    const legacy = await withFlags({ FEATURE_PERPLEXITY: "true" }, () => getProviderAvailability(env({ PERPLEXITY_API_KEY: "pp", PERPLEXITY_SCAN_MODEL: "sonar" })));
    expect(legacy.unavailable).toContainEqual(expect.objectContaining({ slug: "perplexity", reason: "PRICING_MISSING" }));
    await db.aIProvider.update({ where: { slug: "gemini" }, data: { isEnabled: false } });
    const disabled = await withFlags({ FEATURE_GEMINI: "true" }, () => getProviderAvailability(env({ ...KEYS })));
    expect(disabled.unavailable).toContainEqual(expect.objectContaining({ slug: "gemini", reason: "DISABLED" }));
  });

  it("estimates are per engine and differ (search billed differently)", async () => {
    await seed();
    const all = await withFlags({ FEATURE_GEMINI: "true", FEATURE_PERPLEXITY: "true" }, () => getProviderAvailability(env({ ...KEYS })));
    const input = { prompt: "Best CRM for startups", country: "US", language: "en", projectId: "p", promptId: "q" };
    const est = Object.fromEntries(await Promise.all(all.ready.map(async (p) => [p.slug, await p.adapter.estimateCost(input)] as const)));
    expect(est.gemini).toBeGreaterThan(est.perplexity!);
    for (const v of Object.values(est)) expect(v).toBeGreaterThan(0);
  });
});
