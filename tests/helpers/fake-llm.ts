import { LLMError, type LLMRequest, type LLMResponse, type StructuredLLMClient } from "@/server/ai/types";

export type FakeReply = string | object | LLMError | { incomplete: true };

/** Scripted LLM: returns replies in order; objects are JSON-encoded. Records every request. */
export function fakeLLM(replies: FakeReply[] | ((req: LLMRequest, call: number) => FakeReply)): StructuredLLMClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  return {
    provider: "fake",
    model: "fake-model",
    requests,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      requests.push(req);
      const reply = typeof replies === "function" ? replies(req, requests.length) : replies[requests.length - 1];
      if (reply === undefined) throw new Error("fakeLLM: no more scripted replies");
      if (reply instanceof LLMError) throw reply;
      if (typeof reply === "object" && "incomplete" in reply && reply.incomplete === true) {
        return { text: "{", model: "fake-model", latencyMs: 1, incomplete: true, inputTokens: 10, outputTokens: 5 };
      }
      return { text: typeof reply === "string" ? reply : JSON.stringify(reply), model: "fake-model", latencyMs: 1, inputTokens: 100, outputTokens: 50 };
    },
  };
}
