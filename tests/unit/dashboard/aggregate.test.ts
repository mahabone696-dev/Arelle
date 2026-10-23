import { describe, expect, it } from "vitest";
import { citationDomains, dailySeries, latestPerProvider, promptRows, promptStatus, promptsCompetitorWins, whyLosing, type AnswerRow } from "@/server/dashboard/aggregate";
import { resolveWeights } from "@/server/scoring/visibility";

const W = resolveWeights({});
let n = 0;
const ans = (o: Partial<AnswerRow> & { me?: number | null; comps?: Array<[string, number]>; cites?: Array<[string, string, string | null]> }): AnswerRow => {
  const mentions = [
    ...(o.me ? [{ isPrimaryBrand: true, competitorId: null, brandName: "Acme", position: o.me, sentiment: 0.5, snippet: null }] : []),
    ...(o.comps ?? []).map(([id, pos]) => ({ isPrimaryBrand: false, competitorId: id, brandName: id, position: pos, sentiment: 0, snippet: null })),
  ];
  return {
    responseId: `r${++n}`,
    promptId: o.promptId ?? "p1",
    providerId: o.providerId ?? "openai",
    createdAt: o.createdAt ?? new Date("2026-10-01T10:00:00Z"),
    country: "US",
    language: "en",
    brandsMentionedCount: mentions.length,
    mentions,
    citations: (o.cites ?? []).map(([domain, ownerType, competitorId], i) => ({ domain, ownerType, competitorId, url: `https://${domain}/`, title: null, position: i + 1 })),
  };
};

describe("promptStatus", () => {
  it("uses each engine's latest answer", () => {
    const old = ans({ me: 1, createdAt: new Date("2026-09-01") });
    const newer = ans({ me: null, comps: [["hs", 1]], createdAt: new Date("2026-10-01") });
    expect(latestPerProvider([old, newer])).toEqual([newer]);
    expect(promptStatus([old, newer])).toBe("LOSING");
    expect(promptStatus([ans({ me: 2, comps: [["hs", 1]] })])).toBe("VISIBLE");
    expect(promptStatus([ans({ me: 1 })])).toBe("WINNING");
    expect(promptStatus([ans({})])).toBe("NO_BRANDS");
    expect(promptStatus([])).toBe("NOT_SCANNED");
  });
});

describe("dailySeries", () => {
  it("groups by UTC day without inventing empty days", () => {
    const s = dailySeries([ans({ me: 1, createdAt: new Date("2026-10-01T23:00:00Z") }), ans({ me: null, createdAt: new Date("2026-10-03T01:00:00Z") })], [null], W);
    expect(s.map((p) => [p.date, p.sampleSize])).toEqual([["2026-10-01", 1], ["2026-10-03", 1]]);
    expect(s[1]!.scores.primary).toBe(0);
  });
});

describe("promptRows", () => {
  it("computes per-prompt visibility, provider split, best competitor and trend", () => {
    const cur = [ans({ me: 1, providerId: "openai", comps: [["hs", 2]] }), ans({ me: null, providerId: "gemini", comps: [["hs", 1]] })];
    const prev = [ans({ me: null, providerId: "openai", comps: [["hs", 1]] })];
    const [row] = promptRows(["p1", "p2"], cur, prev, ["hs", "pd"], W);
    expect(row).toMatchObject({ promptId: "p1", answers: 2, mentionRate: 0.5, previousVisibility: 0, status: "WINNING", bestCompetitor: { competitorId: "hs" } });
    expect(Object.keys(row!.perProvider).sort()).toEqual(["gemini", "openai"]);
    expect(row!.perProvider.gemini).toBe(0);
    expect(promptRows(["p2"], cur, prev, ["hs"], W)[0]).toMatchObject({ answers: 0, visibility: null, status: "NOT_SCANNED", bestCompetitor: null });
  });
});

describe("citationDomains + gap score (verified by hand)", () => {
  // g2.com cited in 4 answers: 4 with a competitor, 1 with you. acme.com is your own. reddit.com: 1 answer, you only.
  const answers = [
    ans({ me: null, comps: [["hs", 1]], cites: [["g2.com", "THIRD_PARTY", null], ["g2.com", "THIRD_PARTY", null]] }),
    ans({ me: null, comps: [["hs", 1]], cites: [["g2.com", "THIRD_PARTY", null]] }),
    ans({ me: null, comps: [["pd", 1]], cites: [["g2.com", "THIRD_PARTY", null]] }),
    ans({ me: 2, comps: [["hs", 1]], cites: [["g2.com", "THIRD_PARTY", null], ["acme.com", "PRIMARY", null]] }),
    ans({ me: 1, cites: [["reddit.com", "THIRD_PARTY", null]] }),
  ];
  const rows = citationDomains(answers);
  const g2 = rows.find((r) => r.domain === "g2.com")!;

  it("counts citations, share, answers, prompts and co-mentions", () => {
    expect(rows.map((r) => r.domain)).toEqual(["g2.com", "acme.com", "reddit.com"]);
    expect(g2).toMatchObject({ citations: 5, answers: 4, promptsInfluenced: 1, withPrimary: 1, withCompetitor: 4 });
    expect(g2.share).toBe(0.7143); // 5 of 7 citations
  });

  it("scores the gap: 100 × (4/4) × (1 − 1/4) × ln5/ln5 = 75", () => {
    expect(g2.gapScore).toBe(75);
    // reddit: no competitor association → 0; own domain → not a gap
    expect(rows.find((r) => r.domain === "reddit.com")!.gapScore).toBe(0);
    expect(rows.find((r) => r.domain === "acme.com")!.gapScore).toBeNull();
  });
});

describe("prompts a competitor wins", () => {
  it("lists prompts where the competitor appears without you", () => {
    const a = [ans({ promptId: "a", me: null, comps: [["hs", 2]] }), ans({ promptId: "a", me: null, comps: [["hs", 1]] }), ans({ promptId: "b", me: 1, comps: [["hs", 2]] }), ans({ promptId: "c", me: null, comps: [["hs", 3]] })];
    expect(promptsCompetitorWins(a, "hs")).toEqual([{ promptId: "a", answers: 2, bestPosition: 1 }, { promptId: "c", answers: 1, bestPosition: 3 }]);
  });
});

describe("whyLosing", () => {
  const names = { primary: "Acme", competitor: (id: string) => ({ hs: "HubSpot", pd: "Pipedrive" })[id] ?? id };
  it("explains absence, outranking, sources and missing own citations", () => {
    const ins = whyLosing(
      [
        ans({ me: null, comps: [["hs", 1], ["pd", 2]], cites: [["g2.com", "THIRD_PARTY", null]] }),
        ans({ me: null, comps: [["hs", 1]], cites: [["g2.com", "THIRD_PARTY", null], ["capterra.com", "THIRD_PARTY", null]] }),
        ans({ me: 3, comps: [["hs", 1]] }),
      ],
      names,
    );
    expect(ins.map((i) => i.kind)).toEqual(["ABSENT", "OUTRANKED", "SOURCES", "NOT_CITED"]);
    expect(ins[0]!.text).toBe("Acme is missing from 2 of 3 answers; HubSpot, Pipedrive appear instead.");
    expect(ins[0]!.severity).toBe("high");
    expect(ins[1]!.text).toBe("HubSpot is listed above Acme in 1 answer.");
    expect(ins[2]!.text).toBe("Answers without Acme cite g2.com (2), capterra.com (1).");
  });
  it("is empty when there are no answers, and quiet when you win", () => {
    expect(whyLosing([], names)).toEqual([]);
    expect(whyLosing([ans({ me: 1, cites: [["acme.com", "PRIMARY", null]] })], names)).toEqual([]);
  });
});
