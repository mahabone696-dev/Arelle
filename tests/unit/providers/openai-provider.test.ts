import { describe, expect, it } from "vitest";
import { extractCitations, OpenAIProvider } from "@/server/providers/openai";
import { ProviderError } from "@/server/providers/errors";
import { fakeFetchSequence, openAIAnswer } from "../../helpers/fake-openai-responses";

const pricing = { inputCostPer1M: 0.4, outputCostPer1M: 1.6, requestCost: 0.025 };
const input = { prompt: "Best CRM for startups", country: "GB", language: "en", projectId: "p1", promptId: "q1" };
const make = (fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof OpenAIProvider>[0]> = {}) =>
  new OpenAIProvider({ apiKey: "sk-test", model: "gpt-4.1-mini", pricing, fetch, ...extra });

describe("OpenAIProvider.query", () => {
  it("sends the raw prompt with localized web search and returns a normalized result with citations and cost", async () => {
    const { fn, calls } = fakeFetchSequence([
      {
        status: 200,
        body: openAIAnswer("**HubSpot** is popular. [Pipedrive](https://pipedrive.com) too.", {
          citations: [
            { url: "https://g2.com/crm", title: "G2", at: 40 },
            { url: "https://hubspot.com", title: "HubSpot", at: 2 },
            { url: "https://g2.com/crm", title: "G2 again", at: 60 },
          ],
        }),
      },
    ]);
    const res = await make(fn).query(input);
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-4.1-mini",
      input: "Best CRM for startups",
      store: false,
      tools: [{ type: "web_search", user_location: { type: "approximate", country: "GB" } }],
    });
    // No steering instructions are sent with the user's prompt.
    expect(calls[0]!.body.instructions).toBeUndefined();
    expect(res.normalizedText).toBe("HubSpot is popular. Pipedrive too.");
    expect(res.rawText).toContain("**HubSpot**");
    expect(res.citations).toEqual([
      { url: "https://hubspot.com", title: "HubSpot", position: 1 },
      { url: "https://g2.com/crm", title: "G2", position: 2 },
    ]);
    expect(res.model).toBe("gpt-4.1-mini-2025-04-14");
    expect(res.tokenUsage).toEqual({ input: 1200, output: 400, total: 1600 });
    // 1200*0.4/1M + 400*1.6/1M + 1 search * 0.025
    expect(res.estimatedCost).toBeCloseTo(0.00048 + 0.00064 + 0.025, 6);
    expect(res.metadata).toMatchObject({ webSearch: true, webSearchCalls: 1, userLocation: { country: "GB" } });
  });

  it("omits the search tool when web search is disabled", async () => {
    const { fn, calls } = fakeFetchSequence([{ status: 200, body: openAIAnswer("Answer", { searchCalls: 0 }) }]);
    const p = make(fn, { webSearch: false });
    await p.query(input);
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(p.capabilities).toEqual({ citations: false, webSearch: false, location: false });
  });

  it("flags truncated answers but keeps them", async () => {
    const { fn } = fakeFetchSequence([{ status: 200, body: openAIAnswer("Partial answer", { status: "incomplete" }) }]);
    expect((await make(fn).query(input)).metadata.incomplete).toBe(true);
  });

  it.each([
    [{ status: 401, body: { error: { message: "bad key" } } }, "AUTH", false],
    [{ status: 429, body: { error: { message: "quota", code: "insufficient_quota" } } }, "QUOTA_EXCEEDED", false],
    [{ status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "7" } }, "RATE_LIMITED", true],
    [{ status: 500, body: { error: { message: "oops" } } }, "UNAVAILABLE", true],
    [{ status: 400, body: { error: { message: "bad" } } }, "BAD_REQUEST", false],
    [{ status: 404, body: { error: { message: "no model" } } }, "BAD_REQUEST", false],
  ] as const)("maps %j to %s (retryable=%s)", async (response, code, retryable) => {
    const { fn, calls } = fakeFetchSequence([response]);
    const err = await make(fn).query(input).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ code, retryable, provider: "openai" });
    expect(calls).toHaveLength(1); // the queue owns retries
    if (code === "RATE_LIMITED") expect(err.details.retryAfterMs).toBe(7000);
  });

  it("treats empty and refused answers as transparent errors", async () => {
    const empty = fakeFetchSequence([{ status: 200, body: openAIAnswer("  ") }]);
    expect(await make(empty.fn).query(input).catch((e) => e.code)).toBe("EMPTY_RESPONSE");
    const refusal = openAIAnswer("");
    (refusal.output[1] as { content: unknown[] }).content = [{ type: "refusal", refusal: "no" }];
    const refused = fakeFetchSequence([{ status: 200, body: { ...refusal } }]);
    expect(await make(refused.fn).query(input).catch((e) => e.code)).toBe("CONTENT_FILTERED");
  });
});

describe("OpenAIProvider.estimateCost", () => {
  it("is conservative: covers a typical real query's cost", async () => {
    const p = make(fakeFetchSequence([]).fn);
    const est = await p.estimateCost(input);
    const typical = 0.00048 + 0.00064 + 0.025;
    expect(est).toBeGreaterThanOrEqual(typical);
    expect(est).toBeLessThan(0.05);
  });
});

describe("extractCitations", () => {
  it("orders citations across multiple text parts by position", () => {
    const out = [
      { type: "message", content: [
        { type: "output_text", text: "aaaaa", annotations: [{ type: "url_citation", url: "https://b.com", start_index: 3 }] },
        { type: "output_text", text: "bbbbb", annotations: [{ type: "url_citation", url: "https://a.com", start_index: 1 }, { type: "file_citation" }] },
      ] },
    ];
    expect(extractCitations(out).map((c) => c.url)).toEqual(["https://b.com", "https://a.com"]);
  });
});
