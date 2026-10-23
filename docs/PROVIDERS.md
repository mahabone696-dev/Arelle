# AI answer providers

Each engine is an adapter behind `AIAnswerProvider` (`src/server/providers/types.ts`). Scan, analysis and scoring code never branches on the provider. The adapters deliberately **do not** behave identically, and the differences below are recorded on every stored answer (`AIResponse.metadata`) so they're visible rather than hidden.

All three send the prompt **exactly as a user would type it**: no system prompt, no brand steering, and no country or language injected into the text. No adapter ever substitutes another engine's answer. A failure becomes a typed `ProviderError` (`AUTH`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `TIMEOUT`, `UNAVAILABLE`, `BAD_REQUEST`, `CONTENT_FILTERED`, `EMPTY_RESPONSE`, `UNKNOWN`), stored on the scan job and shown in scan results. Retries are owned by the queue, so every paid attempt is counted.

| | ChatGPT (`openai`) | Gemini (`gemini`) | Perplexity (`perplexity`) |
| --- | --- | --- | --- |
| API | Responses API + `web_search` tool | Interactions API (`POST /v1beta/interactions`) + `google_search` tool | Agent API (`POST /v1/agent`) + `web_search` tool |
| Default model | `gpt-4.1-mini` (`OPENAI_SCAN_MODEL`) | `gemini-3.8-flash` (`GEMINI_SCAN_MODEL`), thinking `low` | `perplexity/sonar` (`PERPLEXITY_SCAN_MODEL`), pinned, no `effort` preset |
| Localized to the scan's country | Yes: `user_location.country` | **No**: Google Search grounding has no location parameter; the scan confirmation, prompt detail and metadata (`locationSupported: false`) say so | Yes: `web_search.user_location.country` |
| Citations | Inline `url_citation` annotations | `url_citation` annotations whose URLs are Google redirect links (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`) and whose titles are bare domains; resolved (below) | Inline annotations; if absent, `[n]` / `[web:n]` markers mapped to `search_results` by id (`metadata.citationSource`) |
| Search cost | Per web-search call (`requestCost`) | Per **executed search query** ($14 / 1,000; `usage.grounding_tool_count`) | Per `web_search` invocation ($0.0025), capped by `max_tool_calls` (`PERPLEXITY_SCAN_MAX_SEARCHES`, default 2) |
| Actual cost recorded | Tokens × price + searches | Tokens × price + queries. Conservative: grounding/tool-use tokens counted as input, thinking tokens as output | **Provider-reported** `usage.cost.total_cost` when present (`metadata.costSource: "provider"`), else tokens × price + searches |
| Text normalization | Markdown stripped | Markdown stripped | Markdown stripped, citation markers removed (raw text keeps them) |
| Health check | `models.retrieve` (free) | `GET /models/{model}` (free) | Config only (no free endpoint; a real check would be a paid call) |

## Gemini citation redirects

Gemini grounding returns redirect links instead of source URLs. Left as they are, every Gemini citation would look like `vertexaisearch.cloud.google.com`, and the citation and opportunity data would be wrong. For each redirect the adapter makes **one** `GET` to Google's fixed redirect host with `redirect: "manual"`, reads the `Location` header, and keeps it if it is an http(s) URL on another host. It never requests the destination.

If resolution fails, the citation falls back to `https://<title>/` when the title is a bare domain (Gemini's convention). Otherwise the citation is dropped. Counts are stored in `metadata.citationResolution` (`resolved`, `fallbackToDomain`, `dropped`). The redirect links themselves are not stored.

## Why Perplexity is pinned to `perplexity/sonar`

The Sonar chat-completions API was retired on 2026-09-27. The Agent API offers `effort` presets, but those run whatever model Perplexity currently routes to. At the time of writing, `effort: "fast"` runs an OpenAI model, which would silently turn "Perplexity visibility" into a second ChatGPT-like measurement. The adapter therefore sets `model` explicitly and records `res.model` on every answer.

## Pricing (seeded, USD; verify before launch)

| Model | Input / 1M | Output / 1M | Per search |
| --- | --- | --- | --- |
| gpt-4.1-mini | 0.40 | 1.60 | 0.025 |
| gemini-3.8-flash | 0.75 (1.50 from 2027-01-01) | 3.75 (7.50 from 2027-01-01) | 0.014 per query (5,000/month free, not counted) |
| perplexity/sonar | 0.25 | 2.50 | 0.0025 |

Pre-dispatch estimates are deliberately conservative:
- Gemini assumes 3 search queries per answer.
- Perplexity assumes the maximum number of searches.

Daily caps and the kill switch apply to all engines.

## Turning an engine on

1. Set the key (`GEMINI_API_KEY` / `PERPLEXITY_API_KEY`) for **both** the web service and the worker.
2. Set `FEATURE_GEMINI` / `FEATURE_PERPLEXITY` to `"true"`.
3. Run `pnpm db:seed` (pricing) and `pnpm admin provider enable gemini|perplexity`.
4. Run `pnpm admin provider status`; the engine should show `READY`.
5. Run `pnpm scan:smoke --yes`. It queries every ready engine (5 prompts each) and prints per-engine answers, citations, cost and whether the answers were localized.

## Verification status

The adapters are built against the providers' documented request and response formats (October 2026) and tested with fixtures shaped like them. They have also run end to end through the queue, worker, analysis, opportunities and dashboards against local stand-ins. **They have not yet been run against the live Gemini or Perplexity APIs** because no keys are configured here. Step 5 above is the live check. Two parameters to watch on the first live run:
- **Perplexity `max_tool_calls`** is documented in the migration guide but not on the request reference. A rejection shows up as `BAD_REQUEST` in scan results.
- **Gemini `thinking_level`.**
