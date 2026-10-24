import { describe, expect, it } from "vitest";
import { brandSentiment, clausesMentioning, recommendationStrength, scoreText } from "@/server/analysis/sentiment";
import { extractTextLinks, normalizeCitationUrl, normalizeCitations, registrableDomain } from "@/server/analysis/citations";

describe("sentiment", () => {
  it("scores only the clause about the brand", () => {
    const s = "HubSpot is powerful and easy to use, but Pipedrive can be expensive for small teams.";
    expect(clausesMentioning(s, ["Pipedrive"])).toEqual(["Pipedrive can be expensive for small teams."]);
    expect(brandSentiment([s], ["HubSpot"], "en")).toBeGreaterThan(0.5);
    expect(brandSentiment([s], ["Pipedrive"], "en")).toBeLessThan(0);
  });

  it("handles negation and neutral text", () => {
    expect(scoreText("it is not expensive")).toEqual({ positive: 1, negative: 0 });
    expect(scoreText("the interface isn't intuitive")).toEqual({ positive: 0, negative: 1 });
    expect(scoreText("not easy to use")).toEqual({ positive: 0, negative: 1 });
    expect(brandSentiment(["Zoho CRM offers contact management."], ["Zoho CRM"], "en")).toBe(0);
  });

  it("uses a damped ratio: 1 word → 0.5, 3 words → 0.75", () => {
    expect(brandSentiment(["X is reliable."], ["X"], "en")).toBe(0.5);
    expect(brandSentiment(["X is reliable, fast and affordable."], ["X"], "en")).toBe(0.75);
    expect(brandSentiment(["X is clunky."], ["X"], "en")).toBe(-0.5);
  });

  it("returns null for languages without a deterministic lexicon", () => {
    expect(brandSentiment(["X ist großartig"], ["X"], "de")).toBeNull();
  });

  it("recommendation strength combines rank, phrasing and sentiment", () => {
    // 0.5*(1/1) + 0.3*clamp(0.5+0.25) + 0.2*((0.5+1)/2) = 0.5 + 0.225 + 0.15 = 0.875 → 0.88
    expect(recommendationStrength(1, ["HubSpot is the best overall pick and is reliable."], 0.5)).toBe(0.88);
    // 0.5*(1/4) + 0.3*(0.5-0.15) + 0.2*0.5 = 0.125 + 0.105 + 0.1 = 0.33
    expect(recommendationStrength(4, ["You could also look at Close."], 0)).toBe(0.33);
  });
});

describe("citations", () => {
  it("canonicalizes URLs and strips tracking parameters", () => {
    expect(normalizeCitationUrl("https://www.G2.com/categories/crm/?utm_source=chatgpt.com&b=2&a=1#reviews")).toEqual({
      url: "https://www.g2.com/categories/crm/?b=2&a=1",
      normalizedUrl: "g2.com/categories/crm?a=1&b=2",
      domain: "g2.com",
    });
    expect(normalizeCitationUrl("http://example.com:80/")?.normalizedUrl).toBe("example.com");
    expect(normalizeCitationUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeCitationUrl("not a url")).toBeNull();
  });

  it("groups by registrable domain using the public suffix list", () => {
    expect(registrableDomain("blog.hubspot.com")).toBe("hubspot.com");
    expect(registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("acme.github.io")).toBe("acme.github.io");
  });

  it("extracts markdown and bare links from the answer text", () => {
    expect(extractTextLinks("See [G2](https://g2.com/x) and https://capterra.com/crm. Also (https://a.com/b).")).toEqual([
      { url: "https://g2.com/x", title: "G2" },
      { url: "https://capterra.com/crm" },
    ]);
  });

  it("merges provider citations with text links, dedupes, and classifies owners", () => {
    const out = normalizeCitations(
      [{ url: "https://www.g2.com/crm?utm_source=openai", title: "G2" }, { url: "https://blog.northwind.com/guide" }],
      "Read [HubSpot's blog](https://blog.hubspot.com/sales) or https://g2.com/crm",
      { primaryDomain: "northwind.com", competitorDomains: [{ competitorId: "c1", domain: "hubspot.com" }] },
    );
    expect(out.map((c) => [c.position, c.domain, c.ownerType, c.competitorId])).toEqual([
      [1, "g2.com", "THIRD_PARTY", null],
      [2, "northwind.com", "PRIMARY", null],
      [3, "hubspot.com", "COMPETITOR", "c1"],
    ]);
  });
});

describe("pronoun-led contrast clauses", () => {
  it("attributes 'though it …' to the preceding brand only", () => {
    expect(clausesMentioning("Consider Salesforce, though it has a steep learning curve.", ["Salesforce"])).toEqual(["Consider Salesforce,", "it has a steep learning curve."]);
    expect(clausesMentioning("HubSpot is easy, but Pipedrive is pricey.", ["HubSpot"])).toEqual(["HubSpot is easy,"]);
  });
});
