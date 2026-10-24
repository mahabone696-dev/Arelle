/**
 * OpenAI answer adapter (stands in for "ChatGPT" visibility).
 *
 * Uses the Responses API with the hosted web_search tool so answers are
 * grounded and carry URL citations, approximating ChatGPT with search.
 * The prompt is sent exactly as a user would type it — no system prompt
 * steering towards or away from any brand. The approximate user location is
 * set to the scan's country.
 */
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import { estimateCostUsd, type TokenPricing } from "@/server/ai/cost";
import { ProviderError } from "./errors";
import { normalizeAnswerText } from "./normalize";
import type { AIAnswerProvider, AIQueryCitation, AIQueryInput, AIQueryResult } from "./types";

export interface OpenAIProviderOptions {
  apiKey: string;
  model: string;
  pricing: TokenPricing;
  webSearch?: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  baseURL?: string;
  /** Test seam. */
  fetch?: typeof fetch;
}

// Conservative assumptions for pre-dispatch estimates (actual cost uses real usage).
const EST_OUTPUT_TOKENS = 900;
const EST_SEARCH_CONTEXT_TOKENS = 2500;


interface OutputItem {
  type: string;
  content?: Array<{ type: string; text?: string; refusal?: string; annotations?: Array<{ type: string; url?: string; title?: string; start_index?: number }> }>;
}

export function extractCitations(output: unknown[]): AIQueryCitation[] {
  const found: Array<{ url: string; title?: string; at: number }> = [];
  let offset = 0;
  for (const item of output as OutputItem[]) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text") continue;
      for (const a of part.annotations ?? []) {
        if (a.type === "url_citation" && a.url) found.push({ url: a.url, title: a.title || undefined, at: offset + (a.start_index ?? 0) });
      }
      offset += part.text?.length ?? 0;
    }
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: AIQueryCitation[] = [];
  for (const c of found) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ url: c.url, title: c.title, position: out.length + 1 });
  }
  return out;
}

function mapError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APIConnectionTimeoutError) return new ProviderError("openai", "TIMEOUT", "OpenAI request timed out");
  if (error instanceof APIConnectionError) return new ProviderError("openai", "UNAVAILABLE", "Could not connect to OpenAI");
  if (error instanceof APIError) {
    const status = error.status;
    const code = (error as { code?: string | null }).code;
    const retryAfter = Number(error.headers?.get?.("retry-after"));
    const details = { status, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined };
    if (status === 401 || status === 403) return new ProviderError("openai", "AUTH", "OpenAI rejected the API key", details);
    if (status === 429 && code === "insufficient_quota") return new ProviderError("openai", "QUOTA_EXCEEDED", "OpenAI account quota exhausted", details);
    if (status === 429) return new ProviderError("openai", "RATE_LIMITED", "OpenAI rate limit reached", details);
    if (status === 408 || (status !== undefined && status >= 500)) return new ProviderError("openai", "UNAVAILABLE", `OpenAI unavailable (${status})`, details);
    if (status === 400 || status === 404 || status === 422) return new ProviderError("openai", "BAD_REQUEST", `OpenAI rejected the request (${status})`, details);
  }
  return new ProviderError("openai", "UNKNOWN", "Unexpected OpenAI error");
}

export class OpenAIProvider implements AIAnswerProvider {
  readonly providerName = "openai";
  readonly model: string;
  readonly capabilities;
  private readonly sdk: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.model = options.model;
    this.capabilities = { citations: options.webSearch !== false, webSearch: options.webSearch !== false, location: options.webSearch !== false };
    // Retries are owned by the scan queue so every paid attempt is counted.
    this.sdk = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL, maxRetries: 0, timeout: options.timeoutMs ?? 60_000, fetch: options.fetch });
  }

  async query(input: AIQueryInput): Promise<AIQueryResult> {
    const webSearch = this.capabilities.webSearch;
    const started = Date.now();
    let res: OpenAIResponse;
    try {
      res = (await this.sdk.responses.create({
        model: this.model,
        input: input.prompt,
        max_output_tokens: this.options.maxOutputTokens ?? 2000,
        store: false,
        ...(webSearch ? { tools: [{ type: "web_search" as const, search_context_size: "medium" as const, user_location: { type: "approximate" as const, country: input.country } }] } : {}),
      })) as OpenAIResponse;
    } catch (error) {
      throw mapError(error);
    }
    const latencyMs = Date.now() - started;
    const output = (res.output ?? []) as unknown as OutputItem[];
    const rawText = res.output_text ?? "";
    const refused = output.some((o) => o.type === "message" && o.content?.some((c) => c.type === "refusal"));
    if (!rawText.trim()) {
      throw refused ? new ProviderError("openai", "CONTENT_FILTERED", "OpenAI declined to answer") : new ProviderError("openai", "EMPTY_RESPONSE", "OpenAI returned an empty answer");
    }

    const searchCalls = output.filter((o) => o.type === "web_search_call").length;
    const usage = { input: res.usage?.input_tokens ?? 0, output: res.usage?.output_tokens ?? 0, total: res.usage?.total_tokens ?? 0 };
    const estimatedCost = estimateCostUsd({ inputTokens: usage.input, outputTokens: usage.output, requests: searchCalls }, this.options.pricing);

    return {
      rawText,
      normalizedText: normalizeAnswerText(rawText),
      citations: extractCitations(output),
      model: res.model ?? this.model,
      latencyMs,
      tokenUsage: usage,
      estimatedCost,
      metadata: {
        responseId: res.id,
        status: res.status,
        incomplete: res.status === "incomplete",
        webSearch,
        webSearchCalls: searchCalls,
        userLocation: webSearch ? { country: input.country } : null,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.sdk.models.retrieve(this.model);
      return true;
    } catch {
      return false;
    }
  }

  async estimateCost(input: AIQueryInput): Promise<number> {
    const promptTokens = Math.ceil(input.prompt.length / 4) + 20;
    const searchTokens = this.capabilities.webSearch ? EST_SEARCH_CONTEXT_TOKENS : 0;
    return estimateCostUsd(
      { inputTokens: promptTokens + searchTokens, outputTokens: EST_OUTPUT_TOKENS, requests: this.capabilities.webSearch ? 1 : 0 },
      this.options.pricing,
    );
  }
}
