/** Builds Responses API payloads shaped like OpenAI's, for adapter and pipeline tests. */
export function openAIAnswer(text: string, opts: { citations?: Array<{ url: string; title?: string; at?: number }>; model?: string; searchCalls?: number; status?: string; inputTokens?: number; outputTokens?: number } = {}) {
  const searchCalls = opts.searchCalls ?? 1;
  return {
    id: `resp_${Math.random().toString(36).slice(2)}`,
    object: "response",
    created_at: 1,
    model: opts.model ?? "gpt-4.1-mini-2025-04-14",
    status: opts.status ?? "completed",
    output: [
      ...Array.from({ length: searchCalls }, (_, i) => ({ type: "web_search_call", id: `ws_${i}`, status: "completed", action: { type: "search", query: "q" } })),
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text,
            annotations: (opts.citations ?? []).map((c) => ({ type: "url_citation", url: c.url, title: c.title ?? "", start_index: c.at ?? 0, end_index: (c.at ?? 0) + 5 })),
          },
        ],
      },
    ],
    usage: { input_tokens: opts.inputTokens ?? 1200, output_tokens: opts.outputTokens ?? 400, total_tokens: (opts.inputTokens ?? 1200) + (opts.outputTokens ?? 400), input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
}

export function fakeFetchSequence(responses: Array<{ status: number; body: object; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...r.headers } });
  }) as typeof fetch;
  return { fn, calls };
}
