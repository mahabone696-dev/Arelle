import { describe, expect, it } from "vitest";
import { buildInitialPrompts, finalizePrompts, mentionsAny, templatePrompts, type PromptContext } from "@/server/onboarding/prompts";
import { PROMPT_DISTRIBUTION, PROMPT_INTENTS, TOTAL_INITIAL_PROMPTS } from "@/server/onboarding/intents";
import type { GeneratedPrompt } from "@/server/onboarding/schemas";
import { LLMError } from "@/server/ai/types";
import { fakeLLM } from "../../helpers/fake-llm";

const ctx: PromptContext = {
  brand: { name: "Northwind", domain: "northwind.com", industry: "CRM software", description: "CRM for SMB sales teams", products: ["Northwind CRM"], targetCustomers: ["startups", "real estate agents"], aliases: ["Northwind CRM"] },
  competitors: [{ name: "HubSpot" }, { name: "Pipedrive" }, { name: "Salesforce" }, { name: "Zoho CRM" }, { name: "Close" }],
  topics: ["Pipeline management", "Lead scoring"],
  market: { country: "US", language: "en" },
};

const p = (text: string, intent: GeneratedPrompt["intent"], extra: Partial<GeneratedPrompt> = {}): GeneratedPrompt => ({
  text,
  intent,
  cluster: "CRM",
  priority: 3,
  country: "US",
  language: "en",
  reason: "because",
  ...extra,
});

/** A full, valid AI answer honouring the distribution. */
function aiPromptSet(quotas = PROMPT_DISTRIBUTION): GeneratedPrompt[] {
  return PROMPT_INTENTS.flatMap((intent) =>
    Array.from({ length: quotas[intent] }, (_, i) => {
      const n = `${intent.toLowerCase()} ${i}`;
      if (intent === "BRANDED") return p(`Is Northwind good for ${n}?`, intent);
      if (intent === "COMPARISON") return p(`HubSpot vs Pipedrive for ${n}`, intent);
      if (intent === "ALTERNATIVE") return p(`Alternatives to HubSpot for ${n}`, intent);
      return p(`Best CRM question ${n}`, intent, { priority: 4 });
    }),
  );
}

describe("mentionsAny", () => {
  it("matches whole words case-insensitively", () => {
    expect(mentionsAny("Is northwind any good?", ["Northwind"])).toBe(true);
    expect(mentionsAny("Northwinds of change", ["Northwind"])).toBe(false);
    expect(mentionsAny("Über Café Müller", ["café müller"])).toBe(true);
    expect(mentionsAny("Is it good?", ["A"])).toBe(false); // ignores 1-char names
  });
});

describe("finalizePrompts", () => {
  it("dedupes, enforces market codes and quotas, and rejects unbranded BRANDED prompts", () => {
    const raw = [
      p("Best CRM software", "COMMERCIAL", { priority: 5 }),
      p("best   CRM software!", "COMMERCIAL"),
      p("Is it good?", "BRANDED"),
      p("Northwind reviews", "BRANDED", { country: "GB", language: "de" }),
      p("  “Affordable CRM”  ", "TRANSACTIONAL"),
    ];
    const r = finalizePrompts(raw, ctx, { ...PROMPT_DISTRIBUTION, TRANSACTIONAL: 1 });
    expect(r.accepted.map((x) => x.text)).toEqual(["Best CRM software", "Northwind reviews", "Affordable CRM"]);
    expect(r.accepted.every((x) => x.country === "US" && x.language === "en")).toBe(true);
    expect(r.adjustments.marketOverridden).toBe(1);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(["branded prompt does not mention the brand", "duplicate"]);
    expect(r.missing.TRANSACTIONAL).toBe(0);
    expect(r.missing.COMMERCIAL).toBe(PROMPT_DISTRIBUTION.COMMERCIAL - 1);
  });

  it("reclassifies non-comparison prompts that name the brand as BRANDED", () => {
    const r = finalizePrompts([p("Best CRM like Northwind", "COMMERCIAL"), p("Northwind vs HubSpot", "COMPARISON")], ctx, PROMPT_DISTRIBUTION);
    expect(r.accepted.map((x) => x.intent)).toEqual(["BRANDED", "COMPARISON"]);
    expect(r.adjustments.reclassifiedAsBranded).toBe(1);
  });

  it("keeps the highest-priority prompts when over quota", () => {
    const r = finalizePrompts([p("low", "COMMERCIAL", { priority: 1 }), p("high", "COMMERCIAL", { priority: 5 })], ctx, { ...PROMPT_DISTRIBUTION, COMMERCIAL: 1 });
    expect(r.accepted.map((x) => x.text)).toEqual(["high"]);
  });
});

describe("buildInitialPrompts", () => {
  const counts = (ps: { intent: string }[]) => Object.fromEntries(PROMPT_INTENTS.map((i) => [i, ps.filter((x) => x.intent === i).length]));

  it("produces exactly 30 prompts in the target distribution from a good AI answer", async () => {
    const llm = fakeLLM([{ prompts: aiPromptSet() }]);
    const r = await buildInitialPrompts(llm, ctx);
    expect(TOTAL_INITIAL_PROMPTS).toBe(30);
    expect(r.prompts).toHaveLength(30);
    expect(counts(r.prompts)).toEqual(PROMPT_DISTRIBUTION);
    expect(r.method).toBe("AI");
    for (const x of r.prompts) {
      expect(x).toMatchObject({ country: "US", language: "en", source: "AI_SUGGESTED" });
      expect(x.text && x.cluster && x.reason).toBeTruthy();
      expect(x.priority).toBeGreaterThanOrEqual(1);
      expect(x.priority).toBeLessThanOrEqual(5);
    }
    expect(llm.requests[0]!.system).toContain("COMMERCIAL: 8");
  });

  it("asks a targeted top-up for missing intents and passes existing prompts to avoid duplicates", async () => {
    const partial = aiPromptSet().filter((x) => x.intent !== "ALTERNATIVE");
    const topUp = aiPromptSet({ ...Object.fromEntries(PROMPT_INTENTS.map((i) => [i, 0])), ALTERNATIVE: 4 } as typeof PROMPT_DISTRIBUTION);
    const llm = fakeLLM([{ prompts: partial }, { prompts: topUp }]);
    const r = await buildInitialPrompts(llm, ctx);
    expect(r.prompts).toHaveLength(30);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.system).toContain("ALTERNATIVE: 4");
    expect(llm.requests[1]!.system).toMatch(/exactly these counts per intent — ALTERNATIVE: 4\./);
    expect(JSON.parse(llm.requests[1]!.user).alreadyHave).toHaveLength(26);
  });

  it("fills remaining gaps with labelled templates when AI stays short", async () => {
    const partial = aiPromptSet().filter((x) => x.intent !== "BRANDED");
    const llm = fakeLLM([{ prompts: partial }, { prompts: [p("still not branded", "COMMERCIAL")] }]);
    const r = await buildInitialPrompts(llm, ctx);
    expect(r.prompts).toHaveLength(30);
    expect(r.method).toBe("AI_WITH_TEMPLATES");
    expect(r.prompts.filter((x) => x.source === "TEMPLATE").every((x) => x.intent === "BRANDED")).toBe(true);
  });

  it("falls back to templates when the AI provider fails, and records why", async () => {
    const llm = fakeLLM([new LLMError("FATAL", "401", 401)]);
    const r = await buildInitialPrompts(llm, ctx);
    expect(r.method).toBe("TEMPLATES");
    expect(r.aiError).toBe("PROVIDER_ERROR");
    expect(r.prompts).toHaveLength(30);
    expect(counts(r.prompts)).toEqual(PROMPT_DISTRIBUTION);
  });

  it("without AI: 30 template prompts covering all six intents", async () => {
    const r = await buildInitialPrompts(null, ctx);
    expect(r.prompts).toHaveLength(30);
    expect(counts(r.prompts)).toEqual(PROMPT_DISTRIBUTION);
    expect(r.prompts.filter((x) => x.intent === "BRANDED").every((x) => x.text.includes("Northwind"))).toBe(true);
    expect(r.prompts.filter((x) => x.intent === "ALTERNATIVE").every((x) => !x.text.includes("Northwind"))).toBe(true);
    expect(new Set(r.prompts.map((x) => x.text.toLowerCase())).size).toBe(30);
  });

  it("does not generate English templates for non-English markets", async () => {
    const r = await buildInitialPrompts(null, { ...ctx, market: { country: "DE", language: "de" } });
    expect(r.prompts).toHaveLength(0);
  });

  it("templates need a category", () => {
    expect(templatePrompts({ ...ctx, brand: { ...ctx.brand, industry: "" }, topics: [] })).toEqual([]);
  });
});

describe("templates with few competitors", () => {
  it.each([0, 1, 2])("still yields 30 prompts in the target mix with %i competitors", async (n) => {
    const r = await buildInitialPrompts(null, { ...ctx, competitors: ctx.competitors.slice(0, n) });
    expect(r.prompts).toHaveLength(30);
    for (const intent of PROMPT_INTENTS) expect(r.prompts.filter((x) => x.intent === intent)).toHaveLength(PROMPT_DISTRIBUTION[intent]);
  });
});

describe("template wording", () => {
  it("capitalizes prompts that start with the category", () => {
    const t = templatePrompts({ ...ctx, brand: { ...ctx.brand, industry: "project management software" } });
    expect(t.every((x) => x.text[0] === x.text[0]!.toUpperCase())).toBe(true);
  });
});
