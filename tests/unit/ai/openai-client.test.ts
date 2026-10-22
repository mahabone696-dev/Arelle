import { describe, expect, it } from "vitest";
import { createOpenAIStructuredClient } from "@/server/ai/openai-client";
import { LLMError } from "@/server/ai/types";

function fakeFetch(status: number, body: object) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const request = { system: "SYS", user: "USER", schemaName: "brand_profile", jsonSchema: { type: "object", properties: {}, required: [], additionalProperties: false }, maxOutputTokens: 500 };

describe("OpenAI structured client", () => {
  it("sends a strict json_schema Responses request and parses output text and usage", async () => {
    const { fn, calls } = fakeFetch(200, {
      id: "resp_1",
      object: "response",
      model: "gpt-test-2026",
      status: "completed",
      output: [{ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
      usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
    const client = createOpenAIStructuredClient({ apiKey: "sk-test", model: "gpt-test", fetch: fn });
    const res = await client.complete(request);
    expect(res).toMatchObject({ text: '{"ok":true}', model: "gpt-test-2026", inputTokens: 12, outputTokens: 7, incomplete: false });
    expect(calls[0]!.url).toMatch(/\/responses$/);
    expect(calls[0]!.body).toMatchObject({
      model: "gpt-test",
      instructions: "SYS",
      input: "USER",
      store: false,
      max_output_tokens: 500,
      text: { format: { type: "json_schema", name: "brand_profile", strict: true } },
    });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("flags incomplete responses", async () => {
    const { fn } = fakeFetch(200, { id: "r", object: "response", model: "m", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] });
    const res = await createOpenAIStructuredClient({ apiKey: "k", model: "m", fetch: fn }).complete(request);
    expect(res.incomplete).toBe(true);
  });

  it.each([
    [429, "TRANSIENT"],
    [500, "TRANSIENT"],
    [503, "TRANSIENT"],
    [400, "FATAL"],
    [401, "FATAL"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const { fn, calls } = fakeFetch(status, { error: { message: "nope", type: "x" } });
    const err = await createOpenAIStructuredClient({ apiKey: "k", model: "m", fetch: fn }).complete(request).catch((e) => e);
    expect(err).toBeInstanceOf(LLMError);
    expect(err.kind).toBe(kind);
    expect(calls).toHaveLength(1); // SDK retries disabled; retries are owned by generateStructured
  });
});
