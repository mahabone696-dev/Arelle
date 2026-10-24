/**
 * Opportunity + action engine on realistic scenarios (a CRM vendor, its
 * competitors, and the kinds of answers AI engines actually give).
 */
import { describe, expect, it } from "vitest";
import type { AnswerRow } from "@/server/dashboard/aggregate";
import type { PromptIntent } from "@/generated/prisma/enums";
import { resolveWeights } from "@/server/scoring/visibility";
import { detectOpportunities, type EngineInput, type EnginePrompt, type OpportunityDraft } from "@/server/opportunities/rules";
import { focusPhrase, recommend, sourceKind, type RecommendationDraft } from "@/server/opportunities/recommend";
import { matchPage, type SitePage } from "@/server/opportunities/pages";

const W = resolveWeights({});
const BRAND = { name: "Northwind CRM", domain: "northwind.example", industry: "CRM" };
const COMPETITORS = [
  { id: "hs", name: "HubSpot", domain: "hubspot.com" },
  { id: "sf", name: "Salesforce", domain: "salesforce.com" },
  { id: "pd", name: "Pipedrive", domain: "pipedrive.com" },
  { id: "zo", name: "Zoho CRM", domain: "zoho.com" },
];
const PAGES: SitePage[] = [
  { url: "https://northwind.example/", title: "Northwind CRM — the CRM for small teams", h1: ["The CRM small teams actually use"] },
  { url: "https://northwind.example/pricing", title: "Pricing — Northwind CRM", h1: ["Simple CRM pricing"] },
  { url: "https://northwind.example/features/pipeline", title: "Pipeline management — Northwind CRM", h1: ["Visual CRM pipelines"] },
  { url: "https://northwind.example/integrations", title: "Integrations — Northwind CRM", h1: ["CRM integrations"] },
  { url: "https://northwind.example/crm-for-real-estate", title: "CRM for real estate agents — Northwind CRM", h1: ["The CRM for real estate agents"] },
  { url: "https://northwind.example/blog/cold-email-tips", title: "Cold email tips — Northwind CRM blog", h1: ["12 cold email tips"] },
];
const ENGINES = ["openai", "gemini", "perplexity"];

let seq = 0;
interface A {
  engine?: string;
  me?: number | null;
  comps?: Array<[string, number]>;
  cites?: string[];
  daysAgo?: number;
  sentiment?: number;
}
function answer(promptId: string, a: A): AnswerRow {
  const mentions = [
    ...(a.me ? [{ isPrimaryBrand: true, competitorId: null, brandName: BRAND.name, position: a.me, sentiment: a.sentiment ?? 0.4, snippet: null }] : []),
    ...(a.comps ?? []).map(([id, position]) => ({ isPrimaryBrand: false, competitorId: id, brandName: COMPETITORS.find((c) => c.id === id)!.name, position, sentiment: 0.3, snippet: null })),
  ];
  return {
    responseId: `r${++seq}`,
    promptId,
    providerId: a.engine ?? "openai",
    createdAt: new Date(Date.UTC(2026, 9, 23) - (a.daysAgo ?? 0) * 86_400_000),
    country: "US",
    language: "en",
    brandsMentionedCount: mentions.length,
    mentions,
    citations: (a.cites ?? []).map((domain, i) => ({
      domain,
      ownerType: domain === BRAND.domain ? "PRIMARY" : COMPETITORS.some((c) => c.domain === domain) ? "COMPETITOR" : "THIRD_PARTY",
      competitorId: COMPETITORS.find((c) => c.domain === domain)?.id ?? null,
      url: `https://${domain}/${domain === "forbes.com" ? "advisor/best-crm" : "crm"}`,
      title: null,
      position: i + 1,
    })),
  };
}

/** The same answer pattern from every engine for `weeks` weekly scans. */
function weekly(promptId: string, a: A, weeks = 4, engines = ENGINES): AnswerRow[] {
  return Array.from({ length: weeks }, (_, w) => engines.map((engine) => answer(promptId, { ...a, engine, daysAgo: (weeks - 1 - w) * 7 }))).flat();
}

function prompt(id: string, text: string, intent: PromptIntent, priority = 4): EnginePrompt {
  return { id, text, intent, priority };
}

function run(prompts: EnginePrompt[], answers: AnswerRow[], pages: SitePage[] | null = PAGES): OpportunityDraft[] {
  const input: EngineInput = { brand: BRAND, competitors: COMPETITORS, prompts, answers, pages, weights: W };
  return detectOpportunities(input);
}

function recs(o: OpportunityDraft, prompts: EnginePrompt[]): RecommendationDraft[] {
  return recommend(o, { brand: BRAND, competitors: COMPETITORS, prompt: prompts.find((p) => p.id === o.promptId) ?? null });
}

const BANNED = /guarantee|will rank|will appear|ensure (you|that)|#1 spot|top spot|dominate the|100% (sure|certain)/i;
function assertWellFormed(r: RecommendationDraft) {
  expect(r.title.length).toBeGreaterThan(10);
  expect(r.reason.length).toBeGreaterThan(20);
  expect(r.suggestedAction.split("\n").length).toBeGreaterThanOrEqual(2);
  expect(["LOW", "MEDIUM", "HIGH"]).toContain(r.estimatedImpact);
  for (const text of [r.title, r.reason, r.suggestedAction]) expect(text).not.toMatch(BANNED);
  if (r.targetUrl) expect(() => new URL(r.targetUrl!)).not.toThrow();
}

describe("opportunity + action engine — realistic examples", () => {
  it("1. commercial prompt you're missing everywhere → landing page at a clean URL", () => {
    const ps = [prompt("p1", "Best CRM for startups", "COMMERCIAL", 5)];
    const ops = run(ps, weekly("p1", { comps: [["hs", 1], ["pd", 2]], cites: ["g2.com", "capterra.com"] }));
    const lost = ops.find((o) => o.type === "LOST_PROMPT")!;
    expect(lost).toMatchObject({ promptId: "p1", title: "Missing from “Best CRM for startups”" });
    expect(lost.impactScore).toBeGreaterThanOrEqual(65);
    expect(lost.evidence).toMatchObject({ answers: 12, yourMentions: 0, enginesLosing: 3, leader: { id: "hs" } });
    const [main, faq] = recs(lost, ps);
    expect(main).toMatchObject({ type: "CREATE_LANDING_PAGE", title: "Create a “CRM for startups” landing page", targetUrl: "https://northwind.example/crm-for-startups", estimatedImpact: "HIGH" });
    expect(main!.reason).toContain("absent from 100% of AI answers");
    expect(main!.reason).toContain("HubSpot and Pipedrive are mentioned");
    expect(main!.reason).toContain("g2.com");
    expect(main!.suggestedAction).toContain("honest comparison with HubSpot and Pipedrive");
    expect(faq).toMatchObject({ type: "ADD_FAQ", estimatedImpact: "MEDIUM" });
    [main!, faq!].forEach(assertWellFormed);
  });

  it("2. a matching page already exists → update that page instead of creating one", () => {
    const ps = [prompt("p1", "Best CRM for real estate agents", "COMMERCIAL", 4)];
    const lost = run(ps, weekly("p1", { comps: [["sf", 1], ["zo", 2]] })).find((o) => o.type === "LOST_PROMPT")!;
    const [main] = recs(lost, ps);
    expect(main).toMatchObject({ type: "UPDATE_CONTENT", targetUrl: "https://northwind.example/crm-for-real-estate" });
    expect(main!.title).toBe("Update /crm-for-real-estate to answer “Best CRM for real estate agents”");
    assertWellFormed(main!);
  });

  it("3. “X vs Y” comparison you're left out of → you-vs-X comparison page", () => {
    const ps = [prompt("p1", "HubSpot vs Salesforce", "COMPARISON", 4)];
    const lost = run(ps, weekly("p1", { comps: [["hs", 1], ["sf", 2]], cites: ["forbes.com"] })).find((o) => o.type === "LOST_PROMPT")!;
    const [main] = recs(lost, ps);
    expect(main).toMatchObject({ type: "CREATE_COMPARISON_PAGE", title: "Create a “Northwind CRM vs HubSpot” comparison page", targetUrl: "https://northwind.example/compare/northwind-crm-vs-hubspot" });
    expect(main!.suggestedAction).toContain("HubSpot and Salesforce");
    expect(main!.suggestedAction).toMatch(/fair/);
    assertWellFormed(main!);
  });

  it("4. “alternatives to X” → alternatives page with a migration section", () => {
    const ps = [prompt("p1", "HubSpot alternatives", "ALTERNATIVE", 4)];
    const lost = run(ps, weekly("p1", { comps: [["pd", 1], ["zo", 2], ["sf", 3]] })).find((o) => o.type === "LOST_PROMPT")!;
    const [main] = recs(lost, ps);
    expect(main).toMatchObject({ type: "CREATE_COMPARISON_PAGE", targetUrl: "https://northwind.example/alternatives/hubspot", title: "Create a “HubSpot alternatives” page featuring Northwind CRM" });
    expect(main!.suggestedAction).toContain("importing data from HubSpot");
    expect(main!.suggestedAction).toContain("Pipedrive, Salesforce and Zoho CRM");
    assertWellFormed(main!);
  });

  it("5. engines don't mention you even for your own brand → entity clarity + schema", () => {
    const ps = [prompt("p1", "Is Northwind CRM good?", "BRANDED", 3)];
    const lost = run(ps, weekly("p1", { comps: [["hs", 1]] })).find((o) => o.type === "LOST_PROMPT")!;
    const r = recs(lost, ps);
    expect(r.map((x) => x.type)).toEqual(["IMPROVE_ENTITY_CLARITY", "ADD_SCHEMA"]);
    expect(r[0]!.suggestedAction).toContain("Northwind CRM is a CRM for");
    expect(r[1]!.suggestedAction).toContain("Organization schema");
    r.forEach(assertWellFormed);
  });

  it("6. informational prompt → guide + internal links, ranked below an equivalent commercial gap", () => {
    const ps = [prompt("info", "How to manage a remote sales team", "INFORMATIONAL", 2), prompt("buy", "Best CRM for startups", "COMMERCIAL", 5)];
    const pattern = { comps: [["hs", 1], ["sf", 2]] as Array<[string, number]> };
    const ops = run(ps, [...weekly("info", pattern), ...weekly("buy", pattern)]);
    const info = ops.find((o) => o.promptId === "info")!;
    const buy = ops.find((o) => o.promptId === "buy")!;
    expect(buy.impactScore).toBeGreaterThan(info.impactScore + 15);
    expect(ops.indexOf(buy)).toBeLessThan(ops.indexOf(info));
    const r = recs(info, ps);
    expect(r.map((x) => x.type)).toEqual(["CREATE_CONTENT", "INTERNAL_LINKING"]);
    expect(r[0]!.targetUrl).toBe("https://northwind.example/blog/how-to-manage-a-remote-sales-team");
    r.forEach(assertWellFormed);
  });

  it("7. mentioned but listed below HubSpot → update the page that should win; without a page it's a content gap", () => {
    const ps = [prompt("p1", "Best CRM for real estate agents", "COMMERCIAL", 5)];
    const ops = run(ps, weekly("p1", { me: 3, comps: [["hs", 1], ["pd", 2]] }));
    expect(ops.map((o) => o.type)).toEqual(["POSITION_GAP"]);
    const gap = ops[0]!;
    expect(gap.evidence).toMatchObject({ averagePosition: 3, outrankedBy: { id: "hs", answers: 12 } });
    expect(gap.description).toContain("average position of 3.0");
    const [main, links] = recs(gap, ps);
    expect(main).toMatchObject({ type: "UPDATE_CONTENT", targetUrl: "https://northwind.example/crm-for-real-estate" });
    expect(main!.suggestedAction).toContain("differences from HubSpot");
    expect(links!.type).toBe("INTERNAL_LINKING");
    [main!, links!].forEach(assertWellFormed);

    const noPage = [prompt("p2", "Best CRM for small business", "COMMERCIAL", 5)];
    const [cg] = run(noPage, weekly("p2", { me: 3, comps: [["hs", 1], ["pd", 2]] }));
    expect(cg).toMatchObject({ type: "CONTENT_GAP" });
    expect(cg!.description).toContain("at an average position of 3.0");
    expect(recs(cg!, noPage)[0]).toMatchObject({ type: "CREATE_LANDING_PAGE", targetUrl: "https://northwind.example/crm-for-small-business" });
  });

  it("8. review site, community and editorial citation gaps each get the right outreach", () => {
    const ps = [prompt("p1", "Best CRM software", "COMMERCIAL", 5), prompt("p2", "Top CRM tools", "COMMERCIAL", 4)];
    const answers = [
      ...weekly("p1", { comps: [["hs", 1], ["sf", 2]], cites: ["g2.com", "reddit.com", "forbes.com"] }),
      ...weekly("p2", { me: 2, comps: [["hs", 1]], cites: ["northwind.example"] }, 2),
    ];
    const gaps = run(ps, answers).filter((o) => o.type === "CITATION_GAP");
    expect(gaps.map((g) => g.evidence.domain).sort()).toEqual(["forbes.com", "g2.com", "reddit.com"]);
    const byDomain = Object.fromEntries(gaps.map((g) => [g.evidence.domain!, recs(g, ps)[0]!]));
    expect(byDomain["g2.com"]).toMatchObject({ type: "CITATION_OUTREACH", title: "Build Northwind CRM's presence on g2.com" });
    expect(byDomain["g2.com"]!.suggestedAction).toMatch(/never offer incentives/);
    expect(byDomain["reddit.com"]!.suggestedAction).toMatch(/disclose that you work for Northwind CRM/);
    expect(byDomain["forbes.com"]).toMatchObject({ type: "DIGITAL_PR", targetUrl: "https://forbes.com/advisor/best-crm" });
    expect(byDomain["g2.com"]!.reason).toContain("12 of them mention HubSpot and Salesforce, only 0 mention Northwind CRM");
    Object.values(byDomain).forEach(assertWellFormed);
    expect(sourceKind("www.trustradius.com")).toBe("REVIEW");
    expect(sourceKind("en.wikipedia.org")).toBe("ENCYCLOPEDIA");
  });

  it("9. a competitor dominating a whole intent → comparison page + PR into its roundups (not when the prompts name it)", () => {
    const ps = [prompt("c1", "CRM for marketing agencies", "COMMERCIAL", 4), prompt("c2", "CRM for consultants", "COMMERCIAL", 4), prompt("c3", "Simple CRM for freelancers", "COMMERCIAL", 3)];
    const answers = [
      ...weekly("c1", { comps: [["hs", 1], ["pd", 2]], cites: ["pcmag.com", "g2.com"] }),
      ...weekly("c2", { comps: [["hs", 1], ["sf", 2]], cites: ["pcmag.com"] }),
      ...weekly("c3", { me: 3, comps: [["hs", 1], ["zo", 2]] }, 2),
    ];
    const dom = run(ps, answers).find((o) => o.type === "COMPETITOR_DOMINANCE")!;
    expect(dom).toMatchObject({ title: "HubSpot dominates commercial prompts", promptId: null, fingerprint: "COMPETITOR_DOMINANCE:COMMERCIAL:hs" });
    expect(dom.evidence).toMatchObject({ answers: 30, competitorRate: 1, yourRate: 0.2, prompts: 3 });
    const r = recs(dom, ps);
    expect(r.map((x) => x.type)).toEqual(["CREATE_COMPARISON_PAGE", "DIGITAL_PR"]);
    expect(r[0]!.targetUrl).toBe("https://northwind.example/compare/northwind-crm-vs-hubspot");
    expect(r[1]!.reason).toContain("pcmag.com");
    expect(r[1]!.reason).not.toContain("g2.com"); // review sites get outreach, not a press pitch
    r.forEach(assertWellFormed);

    // Answers to "HubSpot vs …" prompts naturally mention HubSpot: that's not dominance.
    const named = [prompt("n1", "HubSpot vs Pipedrive", "COMPARISON", 4), prompt("n2", "Salesforce vs HubSpot", "COMPARISON", 4)];
    const namedAnswers = [...weekly("n1", { comps: [["hs", 1], ["pd", 2]] }), ...weekly("n2", { comps: [["hs", 1], ["sf", 2]] })];
    expect(run(named, namedAnswers).filter((o) => o.type === "COMPETITOR_DOMINANCE").map((o) => o.evidence.leader?.id)).not.toContain("hs");
  });

  it("10. important transactional prompt with no page on the site → content gap (only when the site was crawled)", () => {
    const ps = [prompt("p1", "Buy CRM for wholesale distributors", "TRANSACTIONAL", 5)];
    const answers = weekly("p1", { me: 2, comps: [["hs", 1]] });
    const gap = run(ps, answers).find((o) => o.type === "CONTENT_GAP")!;
    expect(gap.title).toBe("No page targets “Buy CRM for wholesale distributors”");
    expect(gap.confidenceScore).toBeLessThanOrEqual(0.7);
    expect(recs(gap, ps)[0]).toMatchObject({ type: "CREATE_LANDING_PAGE", targetUrl: "https://northwind.example/buy-crm-for-wholesale-distributors" });
    assertWellFormed(recs(gap, ps)[0]!);
    expect(run(ps, answers, null).some((o) => o.type === "CONTENT_GAP")).toBe(false);
    const withPage = [...PAGES, { url: "https://northwind.example/industries/wholesale-distributors", title: "CRM for wholesale distributors", h1: [] }];
    expect(run(ps, answers, withPage).some((o) => o.type === "CONTENT_GAP")).toBe(false);
  });

  it("11. a brand that wins its prompts gets no opportunities", () => {
    const ps = [prompt("p1", "Best CRM for startups", "COMMERCIAL", 5), prompt("p2", "Northwind CRM pricing", "BRANDED", 3)];
    const ops = run(ps, [...weekly("p1", { me: 1, comps: [["hs", 2]], cites: ["northwind.example"] }), ...weekly("p2", { me: 1 })], [...PAGES, { url: "https://northwind.example/crm-for-startups", title: "CRM for startups", h1: [] }]);
    expect(ops).toEqual([]);
  });

  it("12. no conclusions from a single answer, and a prompt you've recovered is not 'lost'", () => {
    const ps = [prompt("p1", "Best CRM for startups", "COMMERCIAL", 5)];
    expect(run(ps, [answer("p1", { comps: [["hs", 1]] })])).toEqual([]);
    const recovered = [...weekly("p1", { comps: [["hs", 1]] }, 3).map((a) => ({ ...a, createdAt: new Date(a.createdAt.getTime() - 7 * 86_400_000) })), ...ENGINES.map((engine) => answer("p1", { engine, me: 1, comps: [["hs", 2]] }))];
    expect(run(ps, recovered).some((o) => o.type === "LOST_PROMPT")).toBe(false);
  });

  it("13. impact reflects engine coverage and priority; fingerprints are stable and unique", () => {
    const ps = [prompt("one", "Best CRM for agencies", "COMMERCIAL", 3), prompt("all", "Best CRM for consultants", "COMMERCIAL", 5)];
    const answers = [
      ...weekly("one", { comps: [["hs", 1]] }, 4, ["openai"]),
      ...weekly("one", { me: 1 }, 4, ["gemini", "perplexity"]).map((a) => ({ ...a, createdAt: new Date(a.createdAt.getTime() - 3_600_000) })),
      ...weekly("all", { comps: [["hs", 1]] }),
    ];
    const ops = run(ps, answers);
    const all = ops.find((o) => o.promptId === "all" && o.type === "LOST_PROMPT")!;
    expect(all.impactScore).toBeGreaterThan(70);
    expect(ops.some((o) => o.promptId === "one" && o.type === "LOST_PROMPT")).toBe(false); // you're in 2 of 3 engines
    const again = run(ps, answers);
    expect(again.map((o) => o.fingerprint)).toEqual(ops.map((o) => o.fingerprint));
    expect(new Set(ops.map((o) => o.fingerprint)).size).toBe(ops.length);
  });
});

describe("page matching", () => {
  it("ignores category words shared by every page and filler words", () => {
    expect(matchPage("Best CRM for real estate agents", PAGES)?.url).toBe("https://northwind.example/crm-for-real-estate");
    expect(matchPage("Best CRM software", PAGES)?.url).toBe("https://northwind.example/");
    expect(matchPage("CRM with Gmail integration", PAGES)).toBeNull();
    expect(matchPage("CRM integrations", PAGES)?.url).toBe("https://northwind.example/integrations");
    expect(matchPage("Anything", [])).toBeNull();
  });

  it("focus phrases drop leading filler but keep the user's casing", () => {
    expect(focusPhrase("Best CRM for startups")).toBe("CRM for startups");
    expect(focusPhrase("What is the best CRM for SaaS?")).toBe("CRM for SaaS");
  });
});
