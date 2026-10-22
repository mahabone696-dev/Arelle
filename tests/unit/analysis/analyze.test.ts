import { describe, expect, it } from "vitest";
import { analyzeResponse, type BrandContext } from "@/server/analysis/analyze";
import { enrichWithAI, needsAiEnrichment } from "@/server/analysis/ai-enrich";
import { normalizeAnswerText } from "@/server/providers/normalize";
import { fakeLLM } from "../../helpers/fake-llm";

const ctx: BrandContext = {
  primary: { name: "Northwind CRM", aliases: ["Northwind"], domain: "northwind.com" },
  competitors: [
    { id: "hs", name: "HubSpot", aliases: [], domain: "hubspot.com" },
    { id: "pd", name: "Pipedrive", aliases: [], domain: "pipedrive.com" },
    { id: "cl", name: "Close", aliases: [], domain: "close.com" },
    { id: "sf", name: "Salesforce", aliases: [], domain: "salesforce.com" },
  ],
};

const RAW = `Here are the best CRMs for startups:

1. **HubSpot** – The best overall pick: free to start, powerful and easy to use ([hubspot.com](https://www.hubspot.com/products/crm?utm_source=chatgpt.com)).
2. **Pipedrive** – Great pipeline views, but it can be expensive as you add seats.
3. **Northwind CRM** – A newer option that is affordable and intuitive for small teams.

You could also consider Salesforce, though it has a steep learning curve. Close the gap with good process, whatever tool you pick.

Sources: [G2](https://www.g2.com/categories/crm), https://blog.northwind.com/startup-crm-guide`;

const input = (raw: string, language = "en", providerCitations = [{ url: "https://www.g2.com/categories/crm?utm_source=openai", title: "G2 CRM" }]) => ({ rawText: raw, normalizedText: normalizeAnswerText(raw), language, providerCitations });

describe("analyzeResponse (worked example)", () => {
  const r = analyzeResponse(input(RAW), ctx);

  it("detects the primary brand, its rank and sentiment", () => {
    expect(r.primaryBrand).toMatchObject({ mentioned: true, position: 3, cited: true });
    expect(r.primaryBrand.sentiment).toBeGreaterThan(0.5);
  });

  it("detects competitors in order with clause-level sentiment, ignoring 'Close the gap'", () => {
    expect(r.mentions.map((m) => [m.name, m.position])).toEqual([["HubSpot", 1], ["Pipedrive", 2], ["Northwind CRM", 3], ["Salesforce", 4]]);
    const by = Object.fromEntries(r.mentions.map((m) => [m.name, m]));
    expect(by.HubSpot!.sentiment).toBeGreaterThan(0.5);
    expect(by.Salesforce!.sentiment).toBeLessThan(0);
    expect(by.HubSpot!.recommendationStrength).toBeGreaterThan(by.Salesforce!.recommendationStrength);
    expect(r.lowConfidence).toEqual([{ name: "Close", confidence: 0.4 }]);
    expect(r.brandsMentionedCount).toBe(4);
  });

  it("normalizes and classifies citations from annotations and text", () => {
    expect(r.citations.map((c) => [c.position, c.normalizedUrl, c.ownerType])).toEqual([
      [1, "g2.com/categories/crm", "THIRD_PARTY"],
      [2, "hubspot.com/products/crm", "COMPETITOR"],
      [3, "blog.northwind.com/startup-crm-guide", "PRIMARY"],
    ]);
    expect(r.competitors.find((c) => c.name === "HubSpot")!.cited).toBe(true);
    expect(r.competitors.find((c) => c.name === "Pipedrive")!.cited).toBe(false);
  });

  it("handles an answer that doesn't mention the brand", () => {
    const none = analyzeResponse(input("The leading options are HubSpot and Salesforce.", "en", []), ctx);
    expect(none.primaryBrand).toEqual({ mentioned: false, position: null, sentiment: null, recommendationStrength: null, cited: false });
    expect(none.brandsMentionedCount).toBe(2);
  });

  it("handles an answer with no tracked brands at all", () => {
    const empty = analyzeResponse(input("It depends on your needs.", "en", []), ctx);
    expect(empty).toMatchObject({ mentions: [], competitors: [], brandsMentionedCount: 0, citations: [] });
  });
});

describe("AI enrichment for unsupported languages", () => {
  const de = "Die besten CRMs: 1. HubSpot – sehr beliebt. 2. Northwind CRM – günstig und einfach.";

  it("leaves sentiment null without AI and asks only for brands already detected", async () => {
    const base = analyzeResponse(input(de, "de", []), ctx);
    expect(base.mentions.map((m) => m.sentiment)).toEqual([null, null]);
    expect(needsAiEnrichment(base)).toBe(true);

    const llm = fakeLLM([{ brands: [{ key: "primary", sentiment: 0.6, recommendationStrength: 0.7 }, { key: "competitor:hs", sentiment: 0.8, recommendationStrength: 0.9 }, { key: "competitor:INVENTED", sentiment: 1, recommendationStrength: 1 }] }]);
    const { result } = await enrichWithAI(llm, base, de, "de");
    expect(result.method).toBe("AI");
    expect(result.primaryBrand).toMatchObject({ sentiment: 0.6, recommendationStrength: 0.7, position: 2 });
    expect(result.mentions.map((m) => m.key)).toEqual(["competitor:hs", "primary"]); // no invented brands
    expect(llm.requests[0]!.user).toContain("<answer>");
  });

  it("keeps deterministic results when AI output is invalid", async () => {
    const base = analyzeResponse(input(de, "de", []), ctx);
    const llm = fakeLLM(() => ({ brands: [{ key: "primary", sentiment: 7 }] }));
    const { result } = await enrichWithAI(llm, base, de, "de");
    expect(result.method).toBe("DETERMINISTIC");
    expect(result.primaryBrand.sentiment).toBeNull();
  });
});
