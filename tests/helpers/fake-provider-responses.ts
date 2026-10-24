/** Gemini Interactions / Perplexity Agent API payloads shaped like the documented responses (2026-10). */
export function geminiInteraction(text: string, opts: { citations?: Array<{ url: string; title?: string; at?: number }>; queries?: string[]; status?: string; billedSearches?: number; thought?: number } = {}) {
  const queries = opts.queries ?? ["best crm for startups"];
  return {
    id: "int_123",
    status: opts.status ?? "completed",
    model: "gemini-3.8-flash",
    steps: [
      { type: "thought", summary: [{ type: "text", text: "Searching…" }], signature: "sig" },
      { type: "google_search_call", id: "gs1", arguments: { queries }, signature: "sig" },
      { type: "google_search_result", call_id: "gs1", result: [{ search_suggestions: "<div>…</div>" }], is_error: false, signature: "sig" },
      {
        type: "model_output",
        content: [{ type: "text", text, annotations: (opts.citations ?? []).map((c) => ({ type: "url_citation", url: c.url, title: c.title, start_index: c.at ?? 0, end_index: (c.at ?? 0) + 4 })) }],
      },
    ],
    usage: {
      total_input_tokens: 40,
      total_output_tokens: 500,
      total_thought_tokens: opts.thought ?? 120,
      total_tool_use_tokens: 2600,
      total_tokens: 3260,
      grounding_tool_count: [{ type: "google_search", count: opts.billedSearches ?? queries.length }],
    },
  };
}

export function perplexityResponse(text: string, opts: { annotations?: Array<{ url: string; title?: string; at?: number }>; results?: Array<{ id: number; url: string; title: string }>; cost?: number | null; searches?: number; status?: string } = {}) {
  return {
    id: "resp_pplx",
    object: "response",
    created_at: 1,
    status: opts.status ?? "completed",
    model: "perplexity/sonar",
    output: [
      { type: "search_results", queries: ["best crm for startups"], results: (opts.results ?? []).map((r) => ({ ...r, snippet: "…" })) },
      { type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: (opts.annotations ?? []).map((a) => ({ type: "url_citation", url: a.url, title: a.title, start_index: a.at ?? 0, end_index: (a.at ?? 0) + 3 })) }] },
    ],
    usage: {
      input_tokens: 1800,
      output_tokens: 420,
      total_tokens: 2220,
      ...(opts.cost === null ? {} : { cost: { currency: "USD", input_cost: 0.00045, output_cost: 0.00105, total_cost: opts.cost ?? 0.004, tool_calls_cost: 0.0025 } }),
      tool_calls_details: { web_search: { invocation: opts.searches ?? 1, cost_usd: 0.0025 * (opts.searches ?? 1) } },
    },
  };
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
/** fetch double that records requests (url, headers, JSON body) and answers via a router. */
export function fakeFetch(route: Route) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown>; redirect?: string }> = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body ? JSON.parse(String(init.body)) : {}, redirect: init.redirect });
    return route(String(input), init);
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
