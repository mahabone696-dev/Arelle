import { describe, expect, it } from "vitest";
import { PerplexityProvider, stripMarkers } from "@/server/providers/perplexity";
import { ProviderError } from "@/server/providers/errors";
import { fakeFetch, json, perplexityResponse } from "../../helpers/fake-provider-responses";

const pricing = { inputCostPer1M: 0.25, outputCostPer1M: 2.5, requestCost: 0.0025 };
const input = { prompt: "Best CRM for startups", country: "DE", language: "de", projectId: "p1", promptId: "q1" };
const make = (fetch: typeof globalThis.fetch) => new PerplexityProvider({ apiKey: "pplx-test", model: "perplexity/sonar", pricing, fetch, baseURL: "https://pplx.test/v1" });

describe("PerplexityProvider.query", () => {
  it("pins Perplexity's own model, localizes search to the country, uses inline annotations and the billed cost", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(200, perplexityResponse("HubSpot [1] is popular; Pipedrive is cheaper [2].", { annotations: [{ url: "https://pipedrive.com/pricing", at: 40 }, { url: "https://www.g2.com/crm", title: "G2", at: 8 }], results: [{ id: 1, url: "https://www.g2.com/crm", title: "G2" }, { id: 2, url: "https://pipedrive.com/pricing", title: "Pricing" }] })),
    );
    const res = await make(fn).query(input);
    expect(calls[0]!.url).toBe("https://pplx.test/v1/agent");
    expect(calls[0]!.headers.authorization).toBe("Bearer pplx-test");
    expect(calls[0]!.body).toEqual({
      model: "perplexity/sonar",
      input: "Best CRM for startups",
      tools: [{ type: "web_search", user_location: { country: "DE" } }],
      max_tool_calls: 2,
      max_output_tokens: 2000,
      store: false,
    });
    expect(calls[0]!.body).not.toHaveProperty("effort"); // presets route to other vendors' models
    expect(calls[0]!.body).not.toHaveProperty("instructions");
    expect(res.citations).toEqual([
      { url: "https://www.g2.com/crm", title: "G2", position: 1 },
      { url: "https://pipedrive.com/pricing", title: undefined, position: 2 },
    ]);
    expect(res.rawText).toContain("[1]");
    expect(res.normalizedText).toBe("HubSpot is popular; Pipedrive is cheaper.");
    expect(res.estimatedCost).toBe(0.004);
    expect(res.metadata).toMatchObject({ costSource: "provider", citationSource: "annotations", userLocation: { country: "DE" }, locationSupported: true, sourcesConsidered: 2, webSearchCalls: 1 });
  });

  it("maps [n] / [web:n] markers to search results when there are no annotations, and estimates cost when none is reported", async () => {
    const { fn } = fakeFetch(() =>
      json(200, perplexityResponse("Zoho CRM [web:2] and Close [web:1][web:2] fit startups [7].", { results: [{ id: 1, url: "https://close.com", title: "Close" }, { id: 2, url: "https://zoho.com/crm", title: "Zoho" }], cost: null, searches: 2 })),
    );
    const res = await make(fn).query(input);
    expect(res.citations.map((c) => c.url)).toEqual(["https://zoho.com/crm", "https://close.com"]);
    expect(res.metadata).toMatchObject({ citationSource: "markers", costSource: "estimated" });
    expect(res.estimatedCost).toBeCloseTo((1800 * 0.25 + 420 * 2.5) / 1e6 + 2 * 0.0025, 6);
    expect(stripMarkers("A [web:12] b [3].")).toBe("A b.");
  });

  it("maps Perplexity errors transparently", async () => {
    const cases: Array<[number, object, string, boolean]> = [
      [401, { error: { code: 401, message: "Invalid API key", type: "authentication_error" } }, "AUTH", false],
      [402, { error: { code: 402, message: "Insufficient credits", type: "payment_required" } }, "QUOTA_EXCEEDED", false],
      [429, { error: { code: 429, message: "Rate limit exceeded", type: "rate_limit" } }, "RATE_LIMITED", true],
      [500, { error: { code: 500, message: "Internal", type: "server_error" } }, "UNAVAILABLE", true],
      [400, { error: { code: 400, message: "Invalid model", type: "invalid_request" } }, "BAD_REQUEST", false],
    ];
    for (const [status, body, code, retryable] of cases) {
      const err = await make(fakeFetch(() => json(status, body, status === 429 ? { "retry-after": "7" } : {})).fn).query(input).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ provider: "perplexity", code, retryable });
      if (status === 429) expect(err.details.retryAfterMs).toBe(7000);
    }
    const empty = await make(fakeFetch(() => json(200, perplexityResponse("   "))).fn).query(input).catch((e) => e);
    expect(empty).toMatchObject({ code: "EMPTY_RESPONSE" });
  });
});
