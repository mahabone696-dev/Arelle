import { describe, expect, it } from "vitest";
import { computeVisibility, DEFAULT_WEIGHTS, normalizeWeights, positionToScore, resolveWeights, scoreDelta, type ResponseObservation } from "@/server/scoring/visibility";

const o = (mentioned: boolean, position: number | null, sentiment: number | null, cited: boolean, tracked: number): ResponseObservation => ({ mentioned, position, sentiment, cited, trackedBrandMentions: tracked });

describe("visibility score — worked example (verified by hand)", () => {
  // 10 answers. Brand mentioned in 6 at ranks 1,1,2,3,1,5; cited in 3; tracked-brand mentions total 25.
  const obs = [
    o(true, 1, 0.5, true, 3),
    o(true, 1, 0.8, false, 2),
    o(true, 2, 0, false, 4),
    o(true, 3, null, true, 3),
    o(true, 1, 0.2, false, 2),
    o(true, 5, -0.5, false, 5),
    o(false, null, null, true, 2),
    o(false, null, null, false, 3),
    o(false, null, null, false, 1),
    o(false, null, null, false, 0),
  ];
  const r = computeVisibility(obs);

  it("computes each component", () => {
    // mentionRate = 6/10
    expect(r.mentionRate).toBe(0.6);
    // position scores 1, 1, 0.6667, 0.5, 1, 0.3333 → 4.5 / 6 = 0.75
    expect(r.positionScore).toBe(0.75);
    // average rank = (1+1+2+3+1+5)/6 = 2.17
    expect(r.averagePosition).toBe(2.17);
    // share of voice = 6 / 25
    expect(r.shareOfVoice).toBe(0.24);
    // cited in 3 of 10 (citations count even when the brand isn't named)
    expect(r.citationRate).toBe(0.3);
    // sentiment: (0.5 + 0.8 + 0 + 0.2 − 0.5) / 5 = 0.2 → (0.2 + 1) / 2 = 0.6
    expect(r.sentimentScore).toBe(0.2);
    expect(r.components.sentiment).toBe(0.6);
  });

  it("combines them with 35/25/20/10/10 weights", () => {
    // 100 × (0.35·0.6 + 0.25·0.75 + 0.20·0.24 + 0.10·0.3 + 0.10·0.6)
    // = 100 × (0.21 + 0.1875 + 0.048 + 0.03 + 0.06) = 53.55 → 53.6
    expect(r.visibilityScore).toBe(53.6);
    expect(r.sampleSize).toBe(10);
  });
});

describe("edge cases", () => {
  it("perfect visibility is 100", () => {
    expect(computeVisibility([o(true, 1, 1, true, 1), o(true, 1, 1, true, 1)]).visibilityScore).toBe(100);
  });

  it("never mentioned and never cited is 0 (no free sentiment points)", () => {
    const r = computeVisibility([o(false, null, null, false, 3), o(false, null, null, false, 2)]);
    expect(r).toMatchObject({ visibilityScore: 0, mentionRate: 0, positionScore: 0, averagePosition: null, sentimentScore: null });
  });

  it("an empty sample scores 0 without dividing by zero", () => {
    expect(computeVisibility([])).toMatchObject({ sampleSize: 0, visibilityScore: 0, shareOfVoice: 0 });
  });

  it("treats unknown sentiment on mentions as neutral", () => {
    const r = computeVisibility([o(true, 1, null, false, 1)]);
    // 100 × (0.35 + 0.25 + 0.20 + 0 + 0.10·0.5) = 85
    expect(r.visibilityScore).toBe(85);
  });

  it("position score curve", () => {
    expect([1, 2, 3, 5].map((p) => Math.round(positionToScore(p) * 1000) / 1000)).toEqual([1, 0.667, 0.5, 0.333]);
  });
});

describe("weights", () => {
  it("defaults to 35/25/20/10/10", () => {
    expect(resolveWeights({})).toEqual({ weights: DEFAULT_WEIGHTS, version: "w1:35-25-20-10-10" });
  });

  it("are configurable and normalized", () => {
    const w = resolveWeights({ VISIBILITY_WEIGHTS: "2, 1, 1, 0, 0" });
    expect(w.version).toBe("w1:50-25-25-0-0");
    // mention-only answer set: mentioned at rank 2 in 1 of 2, sov 1/2
    const r = computeVisibility([o(true, 2, null, false, 1), o(false, null, null, false, 1)], w);
    // 100 × (0.5·0.5 + 0.25·0.6667 + 0.25·0.5) = 25 + 16.67 + 12.5 = 54.2
    expect(r.visibilityScore).toBe(54.2);
  });

  it("rejects invalid weights", () => {
    expect(() => resolveWeights({ VISIBILITY_WEIGHTS: "1,2,3" })).toThrow();
    expect(() => normalizeWeights({ ...DEFAULT_WEIGHTS, mention: -1 })).toThrow();
    expect(() => normalizeWeights({ mention: 0, position: 0, shareOfVoice: 0, citation: 0, sentiment: 0 })).toThrow();
  });
});

describe("scoreDelta", () => {
  it("reports change vs previous period", () => {
    expect(scoreDelta(68, 60.6)).toBe(7.4);
    expect(scoreDelta(50, null)).toBeNull();
  });
});
