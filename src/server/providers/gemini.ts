/**
 * Gemini answer adapter, via the Gemini API Interactions endpoint with the
 * built-in Google Search grounding tool.
 *
 * Provider-specific behaviour (see docs/PROVIDERS.md):
 * - No user-location parameter exists for Google Search grounding, so answers
 *   are NOT localized to the scan's country (capabilities.location = false;
 *   recorded in metadata). We never inject the country into the prompt.
 * - Citation URLs are Google redirect links (vertexaisearch.cloud.google.com)
 *   and the citation title is only the source's domain. We resolve each
 *   redirect with one request to Google's redirect host (never the
 *   destination) and fall back to the domain from the title.
 * - Search is billed per executed search query, on top of tokens (thinking
 *   tokens are billed as output).
 */
import { estimateCostUsd, type TokenPricing } from "@/server/ai/cost";
import { ProviderError } from "./errors";
import { dedupeCitations, httpError, postJson } from "./http";
import { normalizeAnswerText } from "./normalize";
import type { AIAnswerProvider, AIQueryCitation, AIQueryInput, AIQueryResult } from "./types";

export interface GeminiProviderOptions {
  apiKey: string;
  model: string;
  /** requestCost = price per executed Google Search query. */
  pricing: TokenPricing;
  maxOutputTokens?: number;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  timeoutMs?: number;
  baseURL?: string;
  /** Test seam (also used for redirect resolution). */
  fetch?: typeof fetch;
}

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REDIRECT_HOST = "vertexaisearch.cloud.google.com";
// Conservative pre-dispatch assumptions; actual cost uses reported usage.
const EST_OUTPUT_TOKENS = 1200;
const EST_GROUNDING_TOKENS = 3000;
const EST_SEARCH_QUERIES = 3;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9-]+\.)+[a-z]{2,63}$/i;

interface Annotation {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
}
interface Step {
  type?: string;
  content?: Array<{ type?: string; text?: string; annotations?: Annotation[] }>;
  arguments?: { queries?: string[] };
  is_error?: boolean;
}
interface InteractionResponse {
  id?: string;
  status?: string;
  model?: string;
  steps?: Step[];
  usage?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_thought_tokens?: number;
    total_tool_use_tokens?: number;
    total_tokens?: number;
    grounding_tool_count?: Array<{ type?: string; count?: number }>;
  };
  error?: { message?: string };
}

/** Answer text and raw citations from model_output steps (thoughts are not part of the answer). */
export function parseInteraction(res: InteractionResponse) {
  let text = "";
  const found: Array<{ url: string; title?: string; at: number }> = [];
  const queries: string[] = [];
  for (const step of res.steps ?? []) {
    if (step.type === "google_search_call") queries.push(...(step.arguments?.queries ?? []).filter((q) => q.trim()));
    if (step.type !== "model_output") continue;
    for (const part of step.content ?? []) {
      if (part.type !== "text" || !part.text) continue;
      for (const a of part.annotations ?? []) if (a.type === "url_citation" && a.url) found.push({ url: a.url, title: a.title || undefined, at: text.length + (a.start_index ?? 0) });
      text += (text ? "\n\n" : "") + part.text;
    }
  }
  const reported = res.usage?.grounding_tool_count?.find((g) => g.type === "google_search")?.count;
  return { text, citations: dedupeCitations(found), queries, searchQueries: reported ?? queries.length };
}

const isRedirect = (url: string) => {
  try {
    return new URL(url).hostname === REDIRECT_HOST;
  } catch {
    return false;
  }
};

/**
 * Resolve Google grounding redirect links to the real source URL. One GET to
 * the fixed redirect host with redirects disabled; we read Location and never
 * request the destination. Unresolvable links fall back to https://<title>/
 * when the title is a bare domain (Gemini's convention), else are dropped.
 */
export async function resolveCitations(citations: AIQueryCitation[], doFetch: typeof fetch = fetch, timeoutMs = 4000) {
  let resolved = 0;
  let fallback = 0;
  let dropped = 0;
  const out = await Promise.all(
    citations.map(async (c) => {
      if (!isRedirect(c.url)) return c;
      try {
        const res = await doFetch(c.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (location) {
          const u = new URL(location, c.url);
          if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname !== REDIRECT_HOST) {
            resolved++;
            return { ...c, url: u.toString() };
          }
        }
      } catch {
        // fall through to the title fallback
      }
      if (c.title && DOMAIN.test(c.title.trim())) {
        fallback++;
        return { ...c, url: `https://${c.title.trim().toLowerCase()}/` };
      }
      dropped++;
      return null;
    }),
  );
  const kept = out.filter((c): c is AIQueryCitation => c !== null).map((c, i) => ({ ...c, position: i + 1 }));
  return { citations: kept, stats: { resolved, fallbackToDomain: fallback, dropped } };
}

function mapError(status: number, body: unknown, headers: Headers): ProviderError {
  const err = (body as { error?: { status?: string; message?: string; details?: Array<{ reason?: string }> } } | null)?.error;
  const message = err?.message ?? "";
  const reason = err?.details?.find((d) => d.reason)?.reason;
  // Gemini reports an invalid key as 400 INVALID_ARGUMENT / API_KEY_INVALID.
  const auth = reason === "API_KEY_INVALID" || /api key (not valid|invalid|expired)/i.test(message);
  // 429 RESOURCE_EXHAUSTED covers both rate limits and exhausted quota/billing.
  const quota = status === 429 && /(billing|exceeded your current quota|quota exceeded.*(per day|daily))/i.test(message);
  return httpError("gemini", "Gemini", status, headers, { auth, quota });
}

export class GeminiProvider implements AIAnswerProvider {
  readonly providerName = "gemini";
  readonly model: string;
  readonly capabilities = { citations: true, webSearch: true, location: false };

  constructor(private readonly options: GeminiProviderOptions) {
    this.model = options.model;
  }

  async query(input: AIQueryInput): Promise<AIQueryResult> {
    const started = Date.now();
    const { status, body, headers } = await postJson("gemini", `${this.options.baseURL ?? DEFAULT_BASE}/interactions`, {
      headers: { "x-goog-api-key": this.options.apiKey },
      body: {
        model: this.model,
        // Sent exactly as a user would type it: no system instruction, no brand steering, no injected location.
        input: input.prompt,
        tools: [{ type: "google_search", search_types: ["web_search"] }],
        generation_config: { max_output_tokens: this.options.maxOutputTokens ?? 2000, thinking_level: this.options.thinkingLevel ?? "low" },
        store: false,
      },
      timeoutMs: this.options.timeoutMs ?? 90_000,
      fetch: this.options.fetch,
    });
    if (status < 200 || status >= 300) throw mapError(status, body, headers);
    const res = body as InteractionResponse;
    if (res.status === "failed") throw new ProviderError("gemini", "UNKNOWN", `Gemini interaction failed${res.error?.message ? `: ${res.error.message.slice(0, 200)}` : ""}`);
    const latencyMs = Date.now() - started;
    const parsed = parseInteraction(res);
    if (!parsed.text.trim()) {
      throw res.status === "incomplete" ? new ProviderError("gemini", "EMPTY_RESPONSE", "Gemini returned an incomplete, empty answer") : new ProviderError("gemini", "CONTENT_FILTERED", "Gemini returned no answer (possibly blocked by safety filters)");
    }
    const { citations, stats } = await resolveCitations(parsed.citations, this.options.fetch);

    const u = res.usage ?? {};
    // Conservative: grounding context is counted as input and thinking as output (both billed).
    const inputTokens = (u.total_input_tokens ?? 0) + (u.total_tool_use_tokens ?? 0);
    const outputTokens = (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0);
    const estimatedCost = estimateCostUsd({ inputTokens, outputTokens, requests: parsed.searchQueries }, this.options.pricing);

    return {
      rawText: parsed.text,
      normalizedText: normalizeAnswerText(parsed.text),
      citations,
      model: res.model ?? this.model,
      latencyMs,
      tokenUsage: { input: inputTokens, output: outputTokens, total: u.total_tokens ?? inputTokens + outputTokens },
      estimatedCost,
      metadata: {
        interactionId: res.id,
        status: res.status,
        incomplete: res.status === "incomplete",
        webSearch: true,
        searchQueries: parsed.queries,
        billedSearchQueries: parsed.searchQueries,
        thoughtTokens: u.total_thought_tokens ?? 0,
        // Google Search grounding has no location parameter: the scan's country is not applied.
        userLocation: null,
        locationSupported: false,
        requestedCountry: input.country,
        citationResolution: stats,
      },
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const doFetch = this.options.fetch ?? fetch;
      const res = await doFetch(`${this.options.baseURL ?? DEFAULT_BASE}/models/${encodeURIComponent(this.model)}`, { headers: { "x-goog-api-key": this.options.apiKey }, signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async estimateCost(input: AIQueryInput): Promise<number> {
    const promptTokens = Math.ceil(input.prompt.length / 4) + 20;
    return estimateCostUsd({ inputTokens: promptTokens + EST_GROUNDING_TOKENS, outputTokens: EST_OUTPUT_TOKENS, requests: EST_SEARCH_QUERIES }, this.options.pricing);
  }
}
