/**
 * Perplexity answer adapter, via the Agent API (POST /v1/agent). The Sonar
 * chat-completions API was retired on 2026-09-27.
 *
 * Provider-specific behaviour (see docs/PROVIDERS.md):
 * - We pin Perplexity's own grounded model (`perplexity/sonar` by default)
 *   instead of an `effort` preset: presets run whatever model Perplexity
 *   currently routes to (e.g. `effort: "fast"` → an OpenAI model), which
 *   would silently measure a different engine.
 * - The web_search tool takes a user_location, so answers are localized to
 *   the scan's country.
 * - Citations come from inline annotations; when a response only carries
 *   `[n]` / `[web:n]` markers we map them to the search_results by id.
 * - The API reports the billed cost (usage.cost.total_cost); we use it when
 *   present and fall back to tokens × pricing + search fees.
 */
import { estimateCostUsd, type TokenPricing } from "@/server/ai/cost";
import { ProviderError } from "./errors";
import { dedupeCitations, httpError, postJson } from "./http";
import { normalizeAnswerText } from "./normalize";
import type { AIAnswerProvider, AIQueryInput, AIQueryResult } from "./types";

export interface PerplexityProviderOptions {
  apiKey: string;
  model: string;
  /** requestCost = price per web_search invocation. */
  pricing: TokenPricing;
  maxOutputTokens?: number;
  /** Upper bound on searches per answer (cost control). */
  maxToolCalls?: number;
  timeoutMs?: number;
  baseURL?: string;
  fetch?: typeof fetch;
}

const DEFAULT_BASE = "https://api.perplexity.ai/v1";
const EST_OUTPUT_TOKENS = 900;
const EST_SEARCH_CONTEXT_TOKENS = 3000;
const MARKER = /\[(?:web:)?(\d+)\]/g;

interface AgentResponse {
  id?: string;
  status?: string;
  model?: string;
  output?: Array<{
    type?: string;
    queries?: string[];
    results?: Array<{ id?: number | string; url?: string; title?: string; date?: string }>;
    content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string; title?: string; start_index?: number }> }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cost?: { total_cost?: number; currency?: string; tool_calls_cost?: number };
    tool_calls_details?: Record<string, { invocation?: number; cost_usd?: number }>;
  };
  error?: { message?: string; code?: string | number; type?: string };
}

export function parseAgentResponse(res: AgentResponse) {
  let text = "";
  const annotated: Array<{ url: string; title?: string; at: number }> = [];
  const results = new Map<string, { url: string; title?: string }>();
  const queries: string[] = [];
  for (const item of res.output ?? []) {
    if (item.type === "search_results") {
      queries.push(...(item.queries ?? []));
      for (const r of item.results ?? []) if (r.url && r.id !== undefined) results.set(String(r.id), { url: r.url, title: r.title });
    }
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type !== "output_text" || !part.text) continue;
      for (const a of part.annotations ?? []) if (a.url) annotated.push({ url: a.url, title: a.title || undefined, at: text.length + (a.start_index ?? 0) });
      text += (text ? "\n\n" : "") + part.text;
    }
  }
  let found = annotated;
  let citationSource: "annotations" | "markers" | "none" = annotated.length ? "annotations" : "none";
  if (!annotated.length) {
    // Inline [n] / [web:n] markers refer to search_results by id.
    for (const m of text.matchAll(MARKER)) {
      const r = results.get(m[1]!);
      if (r) found.push({ url: r.url, title: r.title, at: m.index ?? 0 });
    }
    if (found.length) citationSource = "markers";
  }
  found = found.filter((c) => /^https?:\/\//i.test(c.url));
  return { text, citations: dedupeCitations(found), citationSource, sourcesConsidered: results.size, queries };
}

/** Citation markers are presentation, not content: drop them before analysis. */
export const stripMarkers = (text: string) => text.replace(/[ \t]?\[(?:web:)?\d+\]/g, "");

function mapError(status: number, body: unknown, headers: Headers): ProviderError {
  const err = (body as AgentResponse | null)?.error;
  const message = `${err?.message ?? ""} ${err?.type ?? ""} ${err?.code ?? ""}`;
  const quota = status === 402 || /insufficient|credit|quota|balance/i.test(message);
  return httpError("perplexity", "Perplexity", status, headers, { quota: quota && status !== 401 && status !== 403 });
}

export class PerplexityProvider implements AIAnswerProvider {
  readonly providerName = "perplexity";
  readonly model: string;
  readonly capabilities = { citations: true, webSearch: true, location: true };

  constructor(private readonly options: PerplexityProviderOptions) {
    this.model = options.model;
  }

  async query(input: AIQueryInput): Promise<AIQueryResult> {
    const started = Date.now();
    const { status, body, headers } = await postJson("perplexity", `${this.options.baseURL ?? DEFAULT_BASE}/agent`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      body: {
        model: this.model,
        // No instructions: the prompt is sent as a user would type it.
        input: input.prompt,
        tools: [{ type: "web_search", user_location: { country: input.country } }],
        max_tool_calls: this.options.maxToolCalls ?? 2,
        max_output_tokens: this.options.maxOutputTokens ?? 2000,
        store: false,
      },
      timeoutMs: this.options.timeoutMs ?? 90_000,
      fetch: this.options.fetch,
    });
    if (status < 200 || status >= 300) throw mapError(status, body, headers);
    const res = body as AgentResponse;
    if (res.status === "failed") throw new ProviderError("perplexity", "UNKNOWN", `Perplexity response failed${res.error?.message ? `: ${res.error.message.slice(0, 200)}` : ""}`);
    const latencyMs = Date.now() - started;
    const parsed = parseAgentResponse(res);
    if (!parsed.text.trim()) throw new ProviderError("perplexity", "EMPTY_RESPONSE", "Perplexity returned an empty answer");

    const u = res.usage ?? {};
    const usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, total: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) };
    const searches = u.tool_calls_details?.web_search?.invocation ?? (parsed.queries.length ? 1 : 0);
    const reported = typeof u.cost?.total_cost === "number" && (u.cost.currency ?? "USD") === "USD" ? u.cost.total_cost : null;
    const estimatedCost = reported !== null ? Math.round(reported * 1e6) / 1e6 : estimateCostUsd({ inputTokens: usage.input, outputTokens: usage.output, requests: searches }, this.options.pricing);

    return {
      rawText: parsed.text,
      normalizedText: normalizeAnswerText(stripMarkers(parsed.text)),
      citations: parsed.citations,
      model: res.model ?? this.model,
      latencyMs,
      tokenUsage: usage,
      estimatedCost,
      metadata: {
        responseId: res.id,
        status: res.status,
        incomplete: res.status === "incomplete",
        webSearch: true,
        searchQueries: parsed.queries,
        webSearchCalls: searches,
        sourcesConsidered: parsed.sourcesConsidered,
        citationSource: parsed.citationSource,
        costSource: reported !== null ? "provider" : "estimated",
        userLocation: { country: input.country },
        locationSupported: true,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    // No free metadata endpoint is documented; a key check needs a (billed) call, so only verify configuration.
    return Boolean(this.options.apiKey);
  }

  async estimateCost(input: AIQueryInput): Promise<number> {
    const promptTokens = Math.ceil(input.prompt.length / 4) + 20;
    return estimateCostUsd({ inputTokens: promptTokens + EST_SEARCH_CONTEXT_TOKENS, outputTokens: EST_OUTPUT_TOKENS, requests: this.options.maxToolCalls ?? 2 }, this.options.pricing);
  }
}
