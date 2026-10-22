/**
 * OpenAI Responses API client for structured generation. Retries are owned
 * by generateStructured(), so SDK retries are disabled here.
 */
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { LLMError, type LLMRequest, type LLMResponse, type StructuredLLMClient } from "./types";

export interface OpenAIClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Test seam for the HTTP transport. */
  fetch?: typeof fetch;
}

export function createOpenAIStructuredClient(options: OpenAIClientOptions): StructuredLLMClient {
  const sdk = new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: options.timeoutMs ?? 90_000, fetch: options.fetch });
  return {
    provider: "openai",
    model: options.model,
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const started = Date.now();
      try {
        const res = await sdk.responses.create({
          model: options.model,
          instructions: req.system,
          input: req.user,
          max_output_tokens: req.maxOutputTokens,
          store: false,
          text: { format: { type: "json_schema", name: req.schemaName, schema: req.jsonSchema, strict: true } },
        });
        return {
          text: res.output_text ?? "",
          model: res.model ?? options.model,
          inputTokens: res.usage?.input_tokens,
          outputTokens: res.usage?.output_tokens,
          latencyMs: Date.now() - started,
          incomplete: res.status === "incomplete",
        };
      } catch (error) {
        if (error instanceof APIConnectionTimeoutError || error instanceof APIConnectionError) {
          throw new LLMError("TRANSIENT", "OpenAI connection failed or timed out");
        }
        if (error instanceof APIError) {
          const status = error.status;
          const transient = status === 429 || status === 408 || status === 409 || (status !== undefined && status >= 500);
          throw new LLMError(transient ? "TRANSIENT" : "FATAL", `OpenAI request failed (${status ?? "unknown"})`, status);
        }
        throw new LLMError("FATAL", "OpenAI request failed");
      }
    },
  };
}
