import { describe, expect, it } from "vitest";
import { z } from "zod";
import { generateStructured, parseJsonText, StructuredOutputError } from "@/server/ai/structured";
import { toStrictJsonSchema } from "@/server/ai/json-schema";
import { LLMError } from "@/server/ai/types";
import { fakeLLM } from "../../helpers/fake-llm";

const schema = z.object({ name: z.string().min(1), tags: z.array(z.string()).max(3) });
const req = { schema, schemaName: "thing", system: "sys", user: "usr" };
const noSleep = { sleep: async () => {} };

describe("generateStructured", () => {
  it("returns validated data on the first valid response", async () => {
    const llm = fakeLLM([{ name: "Acme", tags: ["a"] }]);
    const res = await generateStructured(llm, req, noSleep);
    expect(res.data).toEqual({ name: "Acme", tags: ["a"] });
    expect(res.usage).toMatchObject({ attempts: 1, inputTokens: 100, outputTokens: 50 });
    expect(llm.requests[0]!.jsonSchema).toMatchObject({ type: "object", additionalProperties: false, required: ["name", "tags"] });
  });

  it("retries malformed JSON, then schema violations, with a repair note", async () => {
    const llm = fakeLLM(["not json {", { name: "", tags: ["a", "b", "c", "d"] }, { name: "Acme", tags: [] }]);
    const res = await generateStructured(llm, req, noSleep);
    expect(res.data.name).toBe("Acme");
    expect(res.usage.attempts).toBe(3);
    expect(llm.requests[1]!.user).toContain("not valid JSON");
    expect(llm.requests[2]!.user).toContain("did not match the required schema");
    expect(llm.requests[2]!.user).toMatch(/name: /);
    // The repair note is appended to — never replaces — the original user content.
    expect(llm.requests[2]!.user.startsWith("usr")).toBe(true);
  });

  it("retries truncated output", async () => {
    const llm = fakeLLM([{ incomplete: true }, { name: "Ok", tags: [] }]);
    const res = await generateStructured(llm, req, noSleep);
    expect(res.usage.attempts).toBe(2);
    expect(llm.requests[1]!.user).toContain("cut off");
  });

  it("gives up after maxAttempts with INVALID_OUTPUT and accumulated usage", async () => {
    const llm = fakeLLM(["{}", "{}", "{}"]);
    const err = await generateStructured(llm, req, noSleep).catch((e) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect(err.failure).toBe("INVALID_OUTPUT");
    expect(err.usage).toMatchObject({ attempts: 3, inputTokens: 300 });
    expect(llm.requests).toHaveLength(3);
  });

  it("retries transient provider errors with backoff but fails fast on fatal ones", async () => {
    const sleeps: number[] = [];
    const transient = fakeLLM([new LLMError("TRANSIENT", "429", 429), { name: "Ok", tags: [] }]);
    await generateStructured(transient, req, { sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([1000]);

    const fatal = fakeLLM([new LLMError("FATAL", "401", 401), { name: "never", tags: [] }]);
    const err = await generateStructured(fatal, req, noSleep).catch((e) => e);
    expect(err.failure).toBe("PROVIDER_ERROR");
    expect(fatal.requests).toHaveLength(1);
  });

  it("never exceeds 5 attempts even if asked to", async () => {
    const llm = fakeLLM(() => "{}");
    await generateStructured(llm, req, { ...noSleep, maxAttempts: 50 }).catch(() => {});
    expect(llm.requests).toHaveLength(5);
  });
});

describe("helpers", () => {
  it("parses fenced JSON", () => {
    expect(parseJsonText('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("produces a strict schema for nested objects and strips unsupported keywords", () => {
    const s = toStrictJsonSchema(z.object({ a: z.string().email().optional(), b: z.array(z.object({ c: z.number().min(0) })) }));
    expect(s).toMatchObject({ additionalProperties: false, required: ["a", "b"] });
    expect(JSON.stringify(s)).not.toContain("format");
    expect(JSON.stringify(s)).not.toContain("$schema");
    expect((s as { properties: { b: { items: object } } }).properties.b.items).toMatchObject({ additionalProperties: false, required: ["c"] });
  });
});
