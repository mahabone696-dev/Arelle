import { describe, expect, it } from "vitest";
import { GeminiProvider, resolveCitations } from "@/server/providers/gemini";
import { ProviderError } from "@/server/providers/errors";
import { fakeFetch, geminiInteraction, json } from "../../helpers/fake-provider-responses";

const pricing = { inputCostPer1M: 0.75, outputCostPer1M: 3.75, requestCost: 0.014 };
const input = { prompt: "Best CRM for startups", country: "GB", language: "en", projectId: "p1", promptId: "q1" };
const make = (fetch: typeof globalThis.fetch) => new GeminiProvider({ apiKey: "gm-test", model: "gemini-3.8-flash", pricing, fetch, baseURL: "https://gemini.test/v1beta" });
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";

describe("GeminiProvider.query", () => {
  it("sends the raw prompt with Google Search grounding, no location, and resolves redirect citations", async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.startsWith(REDIRECT)) return new Response(null, { status: 302, headers: { location: "https://www.g2.com/categories/crm?ref=x" } });
      if (url.includes("/grounding-api-redirect/broken")) return new Response("nope", { status: 500 });
      return json(200, geminiInteraction("**HubSpot** and Pipedrive are popular picks.", {
        citations: [
          { url: `${REDIRECT}`, title: "g2.com", at: 30 },
          { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/broken", title: "capterra.com", at: 2 },
          { url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/broken-2", title: "Some Blog Title", at: 50 },
        ],
        queries: ["best crm for startups", "crm startups 2026"],
      }));
    });
    const res = await make(fn).query(input);
    const api = calls[0]!;
    expect(api.url).toBe("https://gemini.test/v1beta/interactions");
    expect(api.headers["x-goog-api-key"]).toBe("gm-test");
    expect(api.body).toEqual({
      model: "gemini-3.8-flash",
      input: "Best CRM for startups",
      tools: [{ type: "google_search", search_types: ["web_search"] }],
      generation_config: { max_output_tokens: 2000, thinking_level: "low" },
      store: false,
    });
    expect(JSON.stringify(api.body)).not.toContain("GB"); // country is never injected
    // Redirect lookups never follow through to the destination.
    expect(calls.filter((c) => c.url.includes("grounding-api-redirect")).every((c) => c.redirect === "manual")).toBe(true);
    expect(calls.some((c) => c.url.includes("g2.com"))).toBe(false);

    expect(res.rawText).toBe("**HubSpot** and Pipedrive are popular picks.");
    expect(res.normalizedText).toBe("HubSpot and Pipedrive are popular picks.");
    expect(res.citations).toEqual([
      { url: "https://capterra.com/", title: "capterra.com", position: 1 },
      { url: "https://www.g2.com/categories/crm?ref=x", title: "g2.com", position: 2 },
    ]);
    expect(res.metadata).toMatchObject({ locationSupported: false, userLocation: null, requestedCountry: "GB", billedSearchQueries: 2, searchQueries: ["best crm for startups", "crm startups 2026"], citationResolution: { resolved: 1, fallbackToDomain: 1, dropped: 1 } });
    // tokens: input 40 + tool-use 2600; output 500 + thought 120; plus 2 searches × $0.014
    expect(res.tokenUsage).toEqual({ input: 2640, output: 620, total: 3260 });
    expect(res.estimatedCost).toBeCloseTo((2640 * 0.75 + 620 * 3.75) / 1e6 + 2 * 0.014, 6);
    expect(make(fn).capabilities.location).toBe(false);
  });

  it("maps Gemini errors transparently", async () => {
    const cases: Array<[number, object, string, boolean]> = [
      [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] } }, "AUTH", false],
      [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } }, "RATE_LIMITED", true],
      [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } }, "QUOTA_EXCEEDED", false],
      [503, { error: { code: 503, status: "UNAVAILABLE", message: "The model is overloaded." } }, "UNAVAILABLE", true],
      [400, { error: { code: 400, status: "INVALID_ARGUMENT", message: "Unknown field" } }, "BAD_REQUEST", false],
    ];
    for (const [status, body, code, retryable] of cases) {
      const { fn } = fakeFetch(() => json(status, body));
      const err = await make(fn).query(input).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ provider: "gemini", code, retryable });
    }
  });

  it("empty or blocked answers and failed interactions are errors, never empty results", async () => {
    const blocked = await make(fakeFetch(() => json(200, geminiInteraction(""))).fn).query(input).catch((e) => e);
    expect(blocked).toMatchObject({ code: "CONTENT_FILTERED" });
    const incomplete = await make(fakeFetch(() => json(200, geminiInteraction("", { status: "incomplete" }))).fn).query(input).catch((e) => e);
    expect(incomplete).toMatchObject({ code: "EMPTY_RESPONSE", retryable: true });
    const failed = await make(fakeFetch(() => json(200, { ...geminiInteraction("x"), status: "failed", error: { message: "internal" } })).fn).query(input).catch((e) => e);
    expect(failed).toMatchObject({ code: "UNKNOWN" });
    const timeout = await make((async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as typeof fetch).query(input).catch((e) => e);
    expect(timeout).toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("pre-dispatch estimate is conservative (≥ a typical grounded answer)", async () => {
    const est = await make(fakeFetch(() => json(200, {})).fn).estimateCost(input);
    expect(est).toBeGreaterThan((2640 * 0.75 + 620 * 3.75) / 1e6 + 2 * 0.014);
  });
});

describe("resolveCitations", () => {
  it("rejects non-http redirect targets and keeps non-redirect URLs untouched", async () => {
    const fn = (async () => new Response(null, { status: 302, headers: { location: "javascript:alert(1)" } })) as typeof fetch;
    const out = await resolveCitations([{ url: REDIRECT, title: "notadomain", position: 1 }, { url: "https://example.com/a", position: 2 }], fn);
    expect(out.citations).toEqual([{ url: "https://example.com/a", position: 1 }]);
    expect(out.stats).toEqual({ resolved: 0, fallbackToDomain: 0, dropped: 1 });
  });
});
