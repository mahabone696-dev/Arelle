/**
 * Minimal JSON-over-HTTP client for provider adapters that call REST APIs
 * directly (no SDK). Network failures and timeouts become ProviderErrors;
 * HTTP errors are mapped by each adapter, which knows its error format.
 */
import { ProviderError } from "./errors";

export interface HttpResult {
  status: number;
  body: unknown;
  headers: Headers;
}

export async function postJson(
  provider: string,
  url: string,
  init: { headers: Record<string, string>; body: unknown; timeoutMs: number; fetch?: typeof fetch },
): Promise<HttpResult> {
  const doFetch = init.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...init.headers },
      body: JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ProviderError(provider, "TIMEOUT", `${provider} request timed out`);
    throw new ProviderError(provider, "UNAVAILABLE", `Could not connect to ${provider}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body, headers: res.headers };
}

export function retryAfterMs(headers: Headers): number | undefined {
  const v = Number(headers.get("retry-after"));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

/** Shared status → code mapping; adapters refine it with provider-specific error bodies. */
export function httpError(provider: string, label: string, status: number, headers: Headers, opts: { quota?: boolean; auth?: boolean } = {}): ProviderError {
  const details = { status, retryAfterMs: retryAfterMs(headers) };
  if (opts.auth || status === 401 || status === 403) return new ProviderError(provider, "AUTH", `${label} rejected the API key`, details);
  if (opts.quota) return new ProviderError(provider, "QUOTA_EXCEEDED", `${label} account quota or credits exhausted`, details);
  if (status === 429) return new ProviderError(provider, "RATE_LIMITED", `${label} rate limit reached`, details);
  if (status === 408 || status >= 500) return new ProviderError(provider, "UNAVAILABLE", `${label} unavailable (${status})`, details);
  if (status >= 400) return new ProviderError(provider, "BAD_REQUEST", `${label} rejected the request (${status})`, details);
  return new ProviderError(provider, "UNKNOWN", `Unexpected ${label} response (${status})`, details);
}

/** Order-preserving de-duplication of citations by URL, renumbering positions 1..n. */
export function dedupeCitations(found: Array<{ url: string; title?: string; at: number }>) {
  const seen = new Set<string>();
  const out: Array<{ url: string; title?: string; position: number }> = [];
  for (const c of [...found].sort((a, b) => a.at - b.at)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ url: c.url, title: c.title, position: out.length + 1 });
  }
  return out;
}
