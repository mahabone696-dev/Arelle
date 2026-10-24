import { describe, expect, it } from "vitest";
import { isAmbiguousName, isProseSentenceStart, matchBrands, type BrandEntity } from "@/server/analysis/brand-matcher";

const e = (key: string, name: string, extra: Partial<BrandEntity> = {}): BrandEntity => ({ key, name, aliases: [], domain: null, isPrimary: key === "primary", ...extra });
const names = (text: string, entities: BrandEntity[]) => matchBrands(text, entities).map((m) => m.name);

describe("matchBrands", () => {
  const crm = [e("primary", "Northwind CRM", { aliases: ["Northwind"], domain: "northwind.com" }), e("hs", "HubSpot", { domain: "hubspot.com" }), e("pd", "Pipedrive"), e("sf", "Salesforce Inc.")];

  it("orders brands by first appearance and counts occurrences", () => {
    const text = "1. HubSpot – free CRM.\n2. Pipedrive – pipeline focus.\n3. Northwind CRM – built for startups. HubSpot also has paid tiers.";
    const m = matchBrands(text, crm);
    expect(m.map((x) => [x.name, x.occurrences])).toEqual([["HubSpot", 2], ["Pipedrive", 1], ["Northwind CRM", 1]]);
    expect(m[2]!.sentences).toEqual(["3. Northwind CRM – built for startups."]);
  });

  it("matches aliases, domains, possessives, legal suffixes and is case-insensitive for distinctive names", () => {
    expect(names("Try northwind.com today", crm)).toEqual(["Northwind CRM"]);
    expect(names("HUBSPOT's free plan", crm)).toEqual(["HubSpot"]);
    expect(names("Salesforce leads the market", crm)).toEqual(["Salesforce Inc."]);
    expect(names("Northwind is new", crm)).toEqual(["Northwind CRM"]);
  });

  it("does not match inside other words, emails or URLs paths", () => {
    expect(names("Pipedriver and hubspotting are not brands", crm)).toEqual([]);
    expect(names("Email sales@hubspot.com", crm)).toEqual([]);
  });

  it("prefers the longest form so 'Northwind CRM' isn't counted twice", () => {
    const m = matchBrands("Northwind CRM is great.", crm);
    expect(m).toHaveLength(1);
    expect(m[0]!.occurrences).toBe(1);
  });

  describe("ambiguous common-word names", () => {
    const tools = [e("close", "Close", { domain: "close.com" }), e("monday", "Monday")];

    it("ignores lowercase uses and lowers confidence for prose sentence starts", () => {
      expect(names("You want to close more deals by monday.", tools)).toEqual([]);
      const startOnly = matchBrands("Close the deal faster with a CRM.", tools);
      expect(startOnly[0]!.confidence).toBeLessThan(0.5);
    });

    it("counts mid-sentence, list-item and domain mentions with high confidence", () => {
      expect(matchBrands("Teams often pick Close for calling.", tools)[0]!.confidence).toBeGreaterThan(0.8);
      expect(matchBrands("1. Close – built-in calling\n2. Monday – boards", tools).map((m) => [m.name, m.confidence > 0.8])).toEqual([["Close", true], ["Monday", true]]);
      expect(matchBrands("See close.com for pricing.", tools)[0]!.confidence).toBeGreaterThan(0.8);
    });

    it("helpers", () => {
      expect(isAmbiguousName("Close")).toBe(true);
      expect(isAmbiguousName("Pipedrive")).toBe(false);
      expect(isProseSentenceStart("Close is good", 0)).toBe(true);
      expect(isProseSentenceStart("Done. Close is good", 6)).toBe(true);
      expect(isProseSentenceStart("1. Close is good", 3)).toBe(false);
      expect(isProseSentenceStart("We like Close", 8)).toBe(false);
    });
  });

  it("handles non-ASCII brand names", () => {
    expect(names("Für Teams ist Café Müller CRM ideal", [e("cm", "Café Müller CRM")])).toEqual(["Café Müller CRM"]);
  });
});
