import { describe, expect, it } from "vitest";
import { guessCategory } from "@/server/audit/category";
import type { CrawlResult } from "@/server/crawler/crawler";

const site = (title: string, h1: string[] = []) =>
  ({ pages: [{ url: "https://x.com/", title, description: "", headings: { h1, h2: [], h3: [] }, text: "", wordCount: 0, links: [], jsonLd: [] }] }) as unknown as CrawlResult;

describe("guessCategory (audit fallback without an AI model)", () => {
  it("uses a short homepage headline, without the brand name", () => {
    expect(guessCategory(site("Northwind", ["CRM software for small teams"]), "Northwind")).toBe("CRM software for small teams");
    expect(guessCategory(site("Northwind CRM | Project management software"), "Northwind CRM")).toBe("Project management software");
    expect(guessCategory(site("Acme — Accounting software", ["Welcome to Acme!"]), "Acme")).toBe("Accounting software");
  });

  it("rejects long marketing sentences and empty pages rather than guessing badly", () => {
    expect(guessCategory(site("Home", ["We help ambitious companies around the world grow faster than ever before"]), "X")).toBe("");
    expect(guessCategory(site("", ["The all-in-one platform that teams love to use every single day"]), "X")).toBe("");
    expect(guessCategory({ pages: [] } as unknown as CrawlResult, "X")).toBe("");
  });

  it("is safe with regex characters in the brand name", () => {
    expect(guessCategory(site("C++ Tools (beta) | Static analysis tools"), "C++ Tools (beta)")).toBe("Static analysis tools");
  });
});
