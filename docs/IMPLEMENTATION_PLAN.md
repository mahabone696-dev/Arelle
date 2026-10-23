# AI Search Visibility (GEO) Platform — Implementation Plan

Status: **Phase 9 complete** — V1 feature-complete; live provider and Stripe verification pending real keys · Last updated: 2026-10-23

This document is the agreed architecture and phased build plan. It is the
source of truth for structure decisions; update it when a decision changes.

---

## 1. Repository audit (starting point)

| Item | Finding |
| --- | --- |
| Application code | None. The repository contained only Claude Code tooling (`.claude/` — a Scrapling skill and a SessionStart hook). |
| Existing stack | None to preserve. The `.claude/` folder is left untouched. |
| Problems | No `package.json`, no lockfile, no CI, no `.gitignore`. |
| Missing dependencies | Everything — installed in Phase 1 (see §6). |
| Runtime available | Node 22.22, pnpm 10.28, PostgreSQL 16, Redis 7 (local services for dev/test). |

Conclusion: greenfield build on the requested stack. Nothing is overwritten.

---

## 2. Product loop → system modules

```
DISCOVER   onboarding: crawler → brand extraction → competitors → prompts
TRACK      scan engine: Scan → ScanJob (prompt × provider) → AIResponse (immutable)
DIAGNOSE   analysis: mentions, competitor matching, citations, sentiment → VisibilitySnapshot
RECOMMEND  opportunity engine (deterministic rules) → action engine (Recommendation)
FIX        action tracking: PLANNED → IMPLEMENTED (date, URL, notes)
MEASURE    ActionMeasurement: observed before/after visibility (never claims causation)
REPEAT     scheduled scans per plan tier
```

---

## 3. Architecture

### 3.1 Principles

* **Layered, framework-light core.** Business logic lives in `src/server/**`
  and `src/lib/**` as plain TypeScript. It must not import from `next/*`
  (except thin adapters in `src/server/auth`). This keeps it reusable by the
  worker process and testable in isolation.
* **One deployable repo, two processes.**
  * `web` — Next.js (App Router) on Vercel: UI, route handlers, server actions.
  * `worker` — a long-running Node process (`worker/index.ts`) consuming
    BullMQ queues on Redis. Deployed separately (Railway/Fly/Render/ECS).
    The web process only **enqueues**; it never calls paid AI providers
    inside a request (except small, capped onboarding calls).
* **Provider adapters.** All AI engines implement `AIAnswerProvider`
  (`src/server/providers/types.ts`). Business logic resolves adapters
  through a registry keyed by provider slug; it never imports
  `openai`/`@google/genai` directly. A provider that cannot do something
  returns a typed `ProviderError` with a transparent status — we never
  substitute another provider's answer.
* **Immutable history.** `AIResponse`, `BrandMention`, `Citation`, and
  `VisibilitySnapshot` rows are append-only. Re-analysis creates a new
  `analysisVersion`, it never mutates the raw response.
* **International by design.** `country` (ISO-3166-1 alpha-2), `language`
  (ISO-639-1), `locale` (BCP-47), provider, model, and timestamp are stored
  on prompts, scan jobs, responses, and snapshots. V1 UI is English only.
* **Security is server-side.** Every data access goes through central
  authorization helpers (`src/server/auth/authorization.ts`). Hidden buttons
  are never a security boundary.
* **Cost safety first.** Expected query count is computed and stored before a
  scan is dispatched; org/day caps, provider concurrency limits, and a global
  kill switch gate every dispatch.

### 3.2 Request / data flow

```
Browser ──► Next.js (RSC / server actions / route handlers)
              │  validate (Zod) → authorize (org membership) → service
              │
              ├──► PostgreSQL (Prisma, pg driver adapter)
              └──► Redis/BullMQ  (enqueue only)
                        │
                        ▼
                    Worker process
                        ├─ scan-dispatch  : Scan → ScanJobs (checks caps, kill switch)
                        ├─ scan-query     : ScanJob → provider adapter → AIResponse
                        ├─ scan-analyze   : AIResponse → mentions/citations
                        ├─ scan-finalize  : Scan status, VisibilitySnapshot, opportunities
                        └─ crawl          : onboarding website analysis
```

### 3.3 Progress updates

The scan page polls `GET /api/projects/:id/scans/:scanId` (every 2–3s while
`QUEUED|RUNNING`), returning `{ completed, failed, expected }` →
"Scanning 47 / 90 responses". Polling is chosen over SSE/WebSockets because it
is robust on Vercel serverless; it can be upgraded later behind the same API.

---

## 4. Folder structure

```
.
├── docs/
│   └── IMPLEMENTATION_PLAN.md
├── prisma/
│   ├── schema.prisma               # full data model
│   ├── migrations/                 # committed SQL migrations
│   └── seed.ts                     # clearly-labelled DEMO org/data only
├── prisma.config.ts                # Prisma 7 config (schema, migrations, seed)
├── worker/
│   └── index.ts                    # BullMQ worker entrypoint (Phase 3)
├── src/
│   ├── app/                        # Next.js App Router (UI + HTTP only)
│   │   ├── (marketing)/            # public pages, /audit (Phase 9)
│   │   ├── (auth)/                 # sign-in, sign-up
│   │   ├── (app)/                  # authenticated app shell
│   │   │   ├── onboarding/         # Phase 2
│   │   │   ├── orgs/new/
│   │   │   └── [orgSlug]/
│   │   │       ├── projects/new/
│   │   │       └── p/[projectId]/  # overview, prompts, competitors, citations,
│   │   │                           # opportunities, actions, reports, settings
│   │   ├── admin/                  # protected admin area (Phase 9)
│   │   ├── r/[token]/              # read-only shared reports (Phase 9)
│   │   └── api/
│   │       ├── auth/[...nextauth]/
│   │       ├── health/
│   │       ├── projects/[projectId]/...   # scans, progress (Phase 3+)
│   │       └── webhooks/stripe/           # Phase 8
│   ├── components/
│   │   ├── ui/                     # shadcn/ui primitives
│   │   ├── layout/                 # sidebar, top bar, selectors
│   │   └── charts/                 # Recharts wrappers (Phase 5)
│   ├── lib/                        # framework-agnostic utilities
│   │   ├── logger.ts               # structured JSON logger
│   │   ├── monitoring.ts           # error-reporting abstraction (Sentry-ready)
│   │   ├── errors.ts               # typed application errors
│   │   ├── domain.ts               # domain/URL normalization
│   │   ├── i18n.ts                 # country/language/locale catalogues
│   │   └── utils.ts                # cn(), slugify(), ...
│   ├── server/                     # business logic (no React)
│   │   ├── env.ts                  # Zod-validated server env (never sent to client)
│   │   ├── db.ts                   # Prisma client singleton
│   │   ├── auth/                   # Auth.js config, password hashing, authorization
│   │   ├── flags/                  # feature flags
│   │   ├── system/                 # kill switch / system settings
│   │   ├── organizations/          # org service + validation
│   │   ├── projects/               # project service + validation
│   │   ├── audit-log/              # AuditLog writer
│   │   ├── crawler/                # Phase 2: safe-fetch, robots, sitemap, extract
│   │   ├── onboarding/             # Phase 2: brand/competitor/prompt generation
│   │   ├── providers/              # Phase 3/7: AIAnswerProvider + adapters + registry
│   │   ├── scans/                  # Phase 3: scan service, cost estimator, caps
│   │   ├── queue/                  # Phase 3: BullMQ queues + job types
│   │   ├── analysis/               # Phase 4: mention/citation/sentiment extraction
│   │   ├── scoring/                # Phase 4: visibility score (configurable weights)
│   │   ├── opportunities/          # Phase 6: deterministic rule engine
│   │   ├── recommendations/        # Phase 6: action engine
│   │   ├── actions/                # Phase 6: tracking + measurements
│   │   ├── billing/                # Phase 8: plans, Stripe, usage enforcement
│   │   └── reports/                # Phase 9
│   └── proxy.ts                    # Next 16 request proxy (auth redirect only)
├── tests/
│   ├── unit/                       # pure business-logic tests (vitest)
│   └── integration/                # DB-backed tests (separate config)
├── .env.example
└── package.json
```

---

## 5. Prisma schema plan

All IDs are `cuid()` strings. All timestamps are `timestamptz`. Soft-delete is
avoided for analytic history (rows are immutable); configuration entities use
`isActive` / `archivedAt`.

### 5.1 Identity & tenancy
| Model | Purpose / key fields |
| --- | --- |
| `User` | Auth.js user + `passwordHash?`, `isPlatformAdmin`. |
| `Account`, `Session`, `VerificationToken` | Auth.js adapter tables. |
| `Organization` | `name`, `slug` (unique), `isDemo` (demo data isolation), `planTier`. |
| `OrganizationMember` | `(organizationId, userId)` unique, `role: OWNER/ADMIN/MEMBER/VIEWER`. |

### 5.2 Projects & entities
| Model | Key fields |
| --- | --- |
| `Project` | `organizationId`, `name`, `domain`, `country`, `language`, `locale`, `timezone`, `archivedAt`. Unique `(organizationId, domain)`. |
| `Brand` | 1:1 with project — `name`, `domain`, `description`, `industry`, `aliases[]`, `products Json`, `targetCustomers[]`, `markets[]`, `topics[]`. |
| `Competitor` | `projectId`, `name`, `domain`, `aliases[]`, `isActive`, `source: USER/AI_SUGGESTED`. |
| `PromptCluster` | `projectId`, `name`. |
| `Prompt` | `projectId`, `text`, `intent`, `category`, `clusterId`, `country`, `language`, `priority (1–5)`, `opportunityScore`, `reason`, `isActive`, `source`. |

Enums: `PromptIntent = INFORMATIONAL|COMMERCIAL|TRANSACTIONAL|COMPARISON|ALTERNATIVE|BRANDED`;
`PromptCategory = CATEGORY|COMMERCIAL|COMPARISON|ALTERNATIVE|PROBLEM|PURCHASE_INTENT|BRANDED`.

### 5.3 Providers & scanning
| Model | Key fields |
| --- | --- |
| `AIProvider` | `slug` (openai/gemini/perplexity), `displayName`, `isEnabled`, `maxConcurrency`, `requestsPerMinute`, `dailyQueryCap`. |
| `AIModel` | `providerId`, `modelId`, `inputCostPer1M`, `outputCostPer1M`, `isDefault`, `isActive`. |
| `Scan` | `projectId`, `status: QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED/CANCELLED`, `scanType: MANUAL/SCHEDULED/ONBOARDING/AUDIT`, `expectedQueryCount`, `completedCount`, `failedCount`, `estimatedCost`, `actualCost`, `triggeredById`, `startedAt`, `completedAt`, `isDemo`. |
| `ScanJob` | `scanId`, `promptId`, `providerId`, `modelId`, `country`, `language`, `status: PENDING/RUNNING/SUCCEEDED/FAILED/SKIPPED`, `attempts`, `lastError`, `errorCode`. Unique `(scanId, promptId, providerId)` — idempotency guard against loops. |
| `AIResponse` | **Immutable**. `scanId`, `scanJobId` (unique), `promptId`, `providerId`, `model`, `country`, `language`, `promptText` (snapshot), `rawText`, `normalizedText`, `latencyMs`, `inputTokens`, `outputTokens`, `estimatedCost`, `metadata Json`, `isDemo`, `createdAt`. No `updatedAt`. |

### 5.4 Analysis
| Model | Key fields |
| --- | --- |
| `BrandMention` | `responseId`, `analysisVersion`, `competitorId?`, `brandName`, `brandDomain`, `mentionType: PRIMARY/COMPETITOR/OTHER`, `position`, `sentiment (-1..1)`, `recommendationStrength`, `confidence`, `isPrimaryBrand`, `extractionMethod: DETERMINISTIC/AI`. |
| `Citation` | `responseId`, `analysisVersion`, `url`, `normalizedUrl`, `domain`, `title`, `position`. |
| `VisibilitySnapshot` | `projectId`, `scanId`, `providerId?` (null = all providers), `competitorId?` (null = primary brand), `country`, `language`, `date`, `visibilityScore`, `mentionRate`, `shareOfVoice`, `averagePosition`, `citationRate`, `sentimentScore`, `sampleSize`, `weightsVersion`. |

### 5.5 Recommend / fix / measure
| Model | Key fields |
| --- | --- |
| `Opportunity` | `projectId`, `promptId?`, `scanId`, `type: LOST_PROMPT/COMPETITOR_DOMINANCE/CITATION_GAP/POSITION_GAP/CONTENT_GAP`, `title`, `description`, `evidence Json`, `impactScore`, `confidenceScore`, `status: OPEN/DISMISSED/RESOLVED`, `fingerprint` (dedupe across scans). |
| `Recommendation` | `opportunityId`, `type` (CREATE_CONTENT … INTERNAL_LINKING), `title`, `reason` (WHY), `suggestedAction` (HOW), `targetUrl` (WHERE), `estimatedImpact: LOW/MEDIUM/HIGH`, `status: OPEN/PLANNED/IMPLEMENTED/DISMISSED`. |
| `Action` | `recommendationId`, `status: PLANNED/IMPLEMENTED/ABANDONED`, `plannedAt`, `implementedAt`, `implementationUrl`, `notes`, `baselineScore`, `createdById`. |
| `ActionMeasurement` | `actionId`, `scanId`, `measuredAt`, `daysSinceImplementation`, `beforeScore`, `afterScore`, `delta` (labelled "observed change"). |

### 5.6 Billing, usage, platform
| Model | Key fields |
| --- | --- |
| `Subscription` | `organizationId` (unique), `planTier: FREE/STARTER/GROWTH/AGENCY`, `status`, `stripeCustomerId`, `stripeSubscriptionId`, `currentPeriodEnd`, `cancelAtPeriodEnd`. |
| `UsageRecord` | `organizationId`, `metric: PROVIDER_QUERY/SCAN/PROMPT/PROJECT/CRAWL_PAGE/AUDIT`, `quantity`, `costUsd`, `periodKey` (YYYY-MM-DD), `referenceId`. Append-only ledger. |
| `AuditLog` | `organizationId?`, `actorId?`, `action`, `entityType`, `entityId`, `metadata Json`, `ip`, `createdAt`. |
| `SystemSetting` | key/value — `scan.killSwitch`, global daily cap. Read on every dispatch. |
| `FeatureFlag` | `key`, `isEnabled`, optional per-org overrides (`FeatureFlagOverride`). |
| `ReportShare` | `projectId`, `token` (hashed), `expiresAt`, `revokedAt`, `brandingJson` (white-label ready). |
| `PublicAudit` | `domain`, `ipHash`, `status`, `resultJson`, `createdAt` (rate-limit + acquisition funnel). |

### 5.7 Migrations
1. `0001_init` (Phase 1) — the full schema above, so foreign keys and enums are
   stable from day one. Later phases add columns/indexes via new migrations
   only; existing migrations are never edited after merge.
2. Production: `prisma migrate deploy` in the release step (never `migrate dev`).

---

## 6. Dependencies

| Area | Package | Phase |
| --- | --- | --- |
| Web | `next@16`, `react@19`, `react-dom@19` | 1 |
| Styling | `tailwindcss@4`, `@tailwindcss/postcss`, `clsx`, `tailwind-merge`, `class-variance-authority` | 1 |
| UI | shadcn/ui pattern on `@radix-ui/*`, `lucide-react` | 1 |
| DB | `prisma@7`, `@prisma/client@7`, `@prisma/adapter-pg`, `pg` | 1 |
| Auth | `next-auth@5 (Auth.js)`, `@auth/prisma-adapter` | 1 |
| Validation | `zod@4` | 1 |
| Tests | `vitest`, `vite-tsconfig-paths` | 1 |
| Tooling | `typescript`, `eslint@9` + `eslint-config-next`, `prettier`, `tsx`, `dotenv` | 1 |
| Crawler | `cheerio` (HTML parsing), `fast-xml-parser` (sitemaps), `robots-parser`, `ipaddr.js` (SSRF checks) | 2 |
| Jobs | `bullmq`, `ioredis` | 3 |
| AI | `openai` | 3 |
| AI | `@google/genai` (Gemini); Perplexity via its OpenAI-compatible HTTP API | 7 |
| Charts | `recharts` | 5 |
| Billing | `stripe` | 8 |

Passwords are hashed with Node's built-in `crypto.scrypt` (no native deps).

---

## 7. Environment variables

See `.env.example` for the authoritative list. All are **server-only**; none use
the `NEXT_PUBLIC_` prefix except `NEXT_PUBLIC_APP_URL`.

| Variable | Required | Phase | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | 1 | PostgreSQL connection string (pooled in prod). |
| `AUTH_SECRET` | yes | 1 | Auth.js signing secret (`openssl rand -base64 32`). |
| `AUTH_URL` | prod | 1 | Canonical app URL for Auth.js. |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | optional | 1 | Enables Google sign-in when present. |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | optional | 1 | Enables GitHub sign-in when present. |
| `NEXT_PUBLIC_APP_URL` | yes | 1 | Public base URL (links, report shares). |
| `LOG_LEVEL` | no | 1 | `debug|info|warn|error` (default `info`). |
| `PLATFORM_ADMIN_EMAILS` | no | 1 | Comma-separated emails granted admin on sign-up. |
| `FEATURE_GEMINI`, `FEATURE_PERPLEXITY`, `FEATURE_ACTION_ENGINE`, `FEATURE_BILLING`, `FEATURE_PUBLIC_AUDIT`, `FEATURE_REPORTS` | no | 1 | Default-off flags (`true`/`false`). DB flags override. |
| `REDIS_URL` | yes (worker) | 3 | Managed Redis (TLS `rediss://` in prod). |
| `OPENAI_API_KEY` | Phase 2 | 2 | Enables AI brand extraction, competitor and prompt suggestions. Without it onboarding uses a labelled metadata/template fallback. |
| `OPENAI_ONBOARDING_MODEL` | no | 2 | Structured-output model for onboarding (default `gpt-4.1-mini`). Add its price to `AIModel` for cost tracking. |
| `OPENAI_SCAN_MODEL` | no | 3 | Answer model for scans (default `gpt-4.1-mini`); must have an `AIModel` pricing row. |
| `OPENAI_SCAN_WEB_SEARCH` | no | 3 | `true` (default) grounds answers with web search and returns citations. |
| `OPENAI_BASE_URL` | no | 3 | Override API base URL (proxy / test double). |
| `SCAN_ORG_DAILY_QUERY_CAP` | no | 3 | Extra per-org daily cap; the plan limit also applies (lower wins). |
| `SCAN_JOB_MAX_ATTEMPTS`, `SCAN_JOB_BACKOFF_MS` | no | 3 | Query retry policy (default 3 attempts, 5 s exponential). |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Phase 7 | 7 | |
| `PERPLEXITY_API_KEY`, `PERPLEXITY_MODEL` | Phase 7 | 7 | |
| `SCAN_GLOBAL_DAILY_QUERY_CAP` | no | 3 | Hard ceiling across all orgs (default 5000). |
| `SCAN_MAX_QUERIES_PER_SCAN` | no | 3 | Hard ceiling per scan (default 1000). |
| `CRAWLER_MAX_PAGES`, `CRAWLER_MAX_BYTES`, `CRAWLER_TIMEOUT_MS` | no | 2 | Crawler safety limits. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH`, `STRIPE_PRICE_AGENCY` | Phase 8 | 8 | |
| `AUDIT_IP_SALT` | Phase 9 | 9 | Hashing IPs for public audit rate limits. |
| `SENTRY_DSN` | no | any | Picked up by `src/lib/monitoring.ts` when an adapter is added. |

---

## 8. API route plan

Mutations from the app UI use **server actions** (validated with Zod and
authorized centrally). Route handlers exist where an HTTP contract is needed
(polling, webhooks, worker health, future public API).

| Method & path | Phase | Purpose |
| --- | --- | --- |
| `GET/POST /api/auth/[...nextauth]` | 1 | Auth.js. |
| `GET /api/health` | 1 | Liveness + DB check. |
| Server actions in `src/app/(app)/[orgSlug]/onboarding/actions.ts` | 2 | Start/re-run analysis, save brand, suggest/save competitors, generate/review prompts. Implemented as server actions (no public HTTP API); the logic lives in `src/server/onboarding/service.ts` and can be exposed as route handlers later. |
| Server action `runScanAction` | 3 | Create scan (plan, caps, kill switch) → enqueue dispatch. A public `POST` route can wrap `createScan` later. |
| `GET /api/projects/:projectId/scans/:scanId` | 3 | Scan progress (`completed / expected`). |
| `GET /api/projects/:projectId/metrics?from&to&provider` | 5 | Dashboard metrics. |
| `GET /api/projects/:projectId/prompts/:promptId` | 5 | Prompt detail with per-provider answers. |
| `POST /api/projects/:projectId/recommendations/:id/actions` | 6 | Mark planned / implemented. |
| `POST /api/billing/checkout`, `POST /api/billing/portal` | 8 | Stripe Checkout / Billing Portal. |
| `POST /api/webhooks/stripe` | 8 | Signature-verified Stripe webhook. |
| `POST /api/audit` | 9 | Public free audit (rate-limited, captcha-ready). |
| `GET /r/:token` | 9 | Read-only shared report. |
| `POST /api/admin/kill-switch` | 9 | Platform admin only. |

---

## 9. Background worker plan (Phase 3+)

Queues (BullMQ on Redis), each with its own concurrency:

| Queue | Job | Concurrency | Retries |
| --- | --- | --- | --- |
| `scan-dispatch` | Expand a `Scan` into `ScanJob`s, re-check caps & kill switch, enqueue queries. | 2 | 3, exp. backoff |
| `scan-query:<provider>` | One prompt × provider. Calls the adapter, stores `AIResponse`, records `UsageRecord` + cost. | `AIProvider.maxConcurrency` + BullMQ `limiter` from `requestsPerMinute` | 3, exp. backoff (2s, 4s, 8s); non-retryable errors (auth, unsupported) fail fast |
| `scan-analyze` | Parse an `AIResponse` → mentions/citations. | 8 | 3 |
| `scan-finalize` | When `completed + failed == expected`: set `COMPLETED`/`PARTIAL`/`FAILED`, compute snapshots, run opportunity engine, action measurements. | 2 | 5 |
| `crawl` | Onboarding website crawl (if moved off-request). | 4 | 2 |

Cost-safety guards (checked at **dispatch and at each query**):
1. Global kill switch (`SystemSetting scan.killSwitch`) → jobs are `SKIPPED`.
2. Per-scan ceiling `SCAN_MAX_QUERIES_PER_SCAN`; scan refused if exceeded.
3. Plan limits (prompts, scans per period) and per-org daily query cap.
4. Per-provider daily cap and global daily cap from `UsageRecord`.
5. `ScanJob` unique `(scanId, promptId, providerId)` + BullMQ `jobId = scanJob.id`
   → re-enqueuing is idempotent; a loop cannot multiply paid calls.
6. A failed job never fails the scan; finalize decides `PARTIAL` vs `FAILED`.

---

## 10. Visibility score (Phase 4)

`src/server/scoring/visibility.ts` — pure function, configurable weights,
default `{ mention: .35, position: .25, shareOfVoice: .20, citation: .10, sentiment: .10 }`
→ 0–100. Position score `= 1 / position` normalized; sentiment mapped from
[-1,1] to [0,1]. Weights are versioned (`weightsVersion`) so historical
snapshots remain explainable.

---

## 11. Phases

| # | Scope | Exit criteria |
| --- | --- | --- |
| **1** | Repo setup, auth, full DB schema + migration, organizations, projects, dashboard shell, logging, env validation, feature flags, kill-switch setting, authorization helpers. | lint, typecheck, unit tests, integration tests, build all pass. |
| 2 | Onboarding: safe crawler (SSRF-protected), brand extraction (AI → Zod), competitors, 30 prompts, editable review UI. | Onboarding works end-to-end on a real site. |
| 3 | Provider interface + OpenAI adapter, scan queue, workers, response persistence, cost estimation and caps. | Real 5-prompt scan, DB verified. |
| 4 | Response parsing (mentions, competitors, citations, sentiment), visibility scoring. | Tests + manual calc verification. |
| 5 | Overview, Prompts, Prompt detail, Competitors, Citations pages (Recharts). | Verified with real + demo data. |
| 6 | Opportunity engine, Action engine, action tracking & measurements. | ≥10 realistic recommendation tests. |
| 7 | Gemini + Perplexity adapters (provider-specific behaviour documented). | Verified per provider. |
| 8 | Stripe, subscriptions, server-side usage limits, billing portal. | Stripe test mode verified. |
| 9 | Public `/audit`, reports + share links, admin area, polish. | Definition of Done (§12). |

## 12. Definition of Done (V1)

Product brief §32, item by item. "Tests" lists the automated coverage; every item was also exercised in a browser against local stand-in engines.

| # | A real user can… | Where | Tests |
| --- | --- | --- | --- |
| 1 | Create an account | `/sign-up`, Auth.js credentials/OAuth | `credentials` |
| 2 | Create an organization | personal org on sign-up, `/orgs/new` | `authorization` |
| 3 | Enter a website | `/[org]/onboarding` (also prefilled from `/audit`) | `onboarding`, `public-audit` |
| 4 | Have the website analyzed | SSRF-safe crawler + AI extraction (deterministic fallback) | crawler unit tests, `onboarding` |
| 5 | Review the brand | onboarding brand step | `onboarding` |
| 6 | Review competitors | onboarding competitors step | `onboarding` |
| 7 | Review prompts | onboarding prompts step (30 generated) | `onboarding` |
| 8 | Approve prompts | prompts step → `approvedAt` | `onboarding` |
| 9 | Run a scan | project overview "Run scan" | `scan-pipeline` |
| 10 | Have it processed by workers | BullMQ dispatch/query/analyze workers | `scan-pipeline` |
| 11 | See scan history | project scans list, `/scans/[id]` | `scan-pipeline`, `dashboard` |
| 12 | See brand mentions | prompt detail | `analysis` |
| 13 | See citations | Citations page | `analysis`, `dashboard` |
| 14 | See a visibility score | Overview, Competitors | scoring unit tests, `dashboard` |
| 15 | See the dashboard | Overview | `dashboard` |
| 16 | See losing prompts | Prompts (status filter), report | `dashboard`, `reports` |
| 17 | See citation gaps | Citations, Opportunities | `opportunities` |
| 18 | See opportunities | Opportunities | `opportunities` |
| 19 | See recommendations | Actions, recommendation detail (Growth+) | recommendation unit tests (≥10), `opportunities` |
| 20 | Mark an action implemented | recommendation detail | `opportunities` |
| 21 | See before/after (observed change) | recommendation detail, Actions, report | `opportunities` |
| 22 | Be held to usage limits | server-side in every service | `billing-limits` |
| 23 | Pay for a subscription | `/[org]/billing`, Stripe Checkout/Portal/webhooks | `stripe` (stripe-mock) |
| 24 | Have their data isolated from other organizations | `requireOrgAccess`/`requireProjectAccess` everywhere | `authorization` + isolation cases in each suite |
| 25 | Share a read-only report | `/[org]/p/[id]/reports`, `/r/[token]` (Agency) | `reports` |

Not verified here: real OpenAI/Gemini/Perplexity answers and a real Stripe
test-mode account (no keys in this environment) — see PROVIDERS.md and BILLING.md.

---

## 13. Phase 2 notes (as built)

**Flow:** `/[org]/onboarding` (domain + market) → crawl + extraction → `/onboarding/[project]/brand` (editable profile) → `/competitors` (≈5 AI suggestions; add/edit/remove) → `/prompts` (30 prompts; approve/edit/delete/add) → overview.

**Crawler** (`src/server/crawler`): URL policy on every hop; DNS resolved and validated inside the socket lookup (plus IP-literal check in the connector) so validation and connection can't diverge; blocks loopback/private/link-local/metadata/CGNAT/ULA/reserved and their IPv4-mapped/NAT64/6to4 forms; ≤5 redirects; 2 MB body cap; 10 s request timeout and 60 s crawl budget; no compressed bodies; HTML-only pages; robots.txt per RFC 9309 (5xx → homepage only; crawl-delay honoured, >5 s → homepage only); sitemap without entity expansion; depth 1, ≤12 pages, same site only; language-aware, diversified page selection.

**AI structured output** (`src/server/ai`): Zod schema → strict JSON Schema → OpenAI Responses API (`json_schema`, strict). Every response is re-validated; malformed/truncated output retried with a repair note (≤3 attempts, hard max 5); transient errors back off; fatal errors stop. All failures logged; usage and cost recorded per call (`UsageRecord AI_EXTRACTION`). Website text is passed as delimited untrusted data.

**Prompt generation:** target mix INFORMATIONAL 5 · COMMERCIAL 8 · TRANSACTIONAL 4 · COMPARISON 5 · ALTERNATIVE 4 · BRANDED 4 = 30. A deterministic finalizer enforces market codes, dedupes, rejects unbranded BRANDED prompts, reclassifies brand-naming prompts, and applies quotas; shortfalls get one targeted AI top-up, then English templates (stored `source = TEMPLATE`, labelled in the UI).

**Fallbacks are explicit:** without an AI key (or when AI fails / the daily AI budget is reached) the brand profile is metadata-only (`WebsiteAnalysis.method = DETERMINISTIC`), competitors are not guessed, and prompts come from templates — all labelled. Nothing is presented as AI output when it isn't.

**Limits:** 10 analyses/user/hour, 30/org/day, 120 AI calls/org/day, 30 generations/user/hour (plan-based in Phase 8). Max 10 competitors, 200 prompts per project.

**Migrations:** `onboarding` (WebsiteAnalysis, onboarding step, competitor reason/confidence, prompt approvedAt, `TEMPLATE` source), `backfill_prompt_approval`, `prompt_reviewed_at`, `backfill_prompt_reviewed_at`.

---

## 14. Phase 3 notes (as built)

**Provider abstraction** (`src/server/providers`): `AIAnswerProvider` (`query`, `healthCheck`, `estimateCost`, `capabilities`), typed `ProviderError` (code + `retryable`), registry that reports every unavailable provider with a reason (`DISABLED`, `FEATURE_OFF`, `NOT_CONFIGURED`, `NOT_IMPLEMENTED`, `PRICING_MISSING`). Only `OpenAIProvider` exists: Responses API, prompt sent verbatim (no steering instructions), `web_search` tool with approximate user location = scan country, URL citations extracted in answer order, cost from real token usage + per-search fee.

**Admission** (`src/server/scans/service.ts`), all before anything is queued: kill switch → ready providers → active prompts → plan (`promptCount × providerCount = expectedQueryCount`, conservative cost estimate) → per-scan max → plan tier (prompts per project, manual scans/day) → org/global/provider daily query caps → one active scan per project. Checks + `Scan`/`ScanJob` creation run in one transaction under a Postgres advisory lock. If the queue is down the scan is marked FAILED and its jobs SKIPPED.

**Execution** (`src/server/scans/{dispatch,execute,lifecycle}.ts`, `src/server/queue`, `worker/`): BullMQ queues `scan-dispatch`, `scan-query-<provider>`, `scan-maintenance`. Queue job id = DB id (idempotent). Per-provider queues carry global concurrency and global rate limits (cross-process). Before every paid call: kill switch, scan state, and an atomic Redis quota (global/org/provider per UTC day, Lua INCR with rollback). Retryable errors (429/5xx/timeout/empty) retry with exponential backoff; fatal ones (auth, quota, bad request, content filter) fail fast. Each job reaches one terminal state via a conditional update that also bumps the scan counter; the scan finalizes exactly once as `COMPLETED` / `PARTIAL` / `FAILED` / `CANCELLED`. A sweeper re-dispatches lost `QUEUED` scans and fails jobs of scans running > 6 h.

**Persistence**: `AIResponse` written once per job (unique `scanJobId`; duplicates keep the first) with raw + normalized text, model, latency, tokens, cost, citations in metadata; a DB trigger rejects any `UPDATE`. `UsageRecord PROVIDER_QUERY` per answer with cost; `Scan.actualCost` vs `estimatedCost`.

**Operations**: `pnpm worker:dev` / `worker:build` + `worker:start` (esbuild bundle, deploy separately), `pnpm admin kill-switch on|off|status`, `pnpm admin provider status|enable|disable <slug>`, `pnpm scan:smoke --yes` (real 5-prompt OpenAI scan through the normal admission path).

**Migration**: `scan_pipeline` (Scan.promptCount/providerCount/plan + AIResponse immutability trigger).

---

## 15. Phase 4 notes (as built)

**Analysis** (`src/server/analysis`), run by the worker after a scan finalizes (`scan-analyze` queue; sweeper re-enqueues lost jobs; `pnpm admin analyze <scanId>` re-runs):
- *Brand matching* — name, name without legal suffix, aliases, domain; whole-word, Unicode-aware, possessives. Names that are ordinary words (Close, Monday, Notion…) match case-sensitively; at a prose sentence start they get confidence 0.4 and don't count (kept as `lowConfidence`). List-item/line starts count.
- *Position* — rank by first appearance among tracked brands (primary + competitors) in the answer.
- *Sentiment* — English lexicon on the clause(s) mentioning the brand (split on but/while/however/…; pronoun-led clauses attach to the preceding brand), negation within 3 tokens, damped ratio `(pos − neg)/(pos + neg + 1)`. Other languages: null, or AI-scored when `FEATURE_ANALYSIS_AI` is on (Zod-validated; AI never adds brands).
- *Recommendation strength* — `0.5·(1/rank) + 0.3·phrasing + 0.2·sentiment01`.
- *Citations* — provider annotations first, then markdown/bare links; tracking params, fragments, `www`, trailing slashes removed; grouped by registrable domain (Public Suffix List via `tldts`); classified PRIMARY / COMPETITOR / THIRD_PARTY.
- Output validated by `analysisResultSchema`; stored as `ResponseAnalysis` (+ `BrandMention`, `Citation`) per `analysisVersion`.

**Visibility score** (`src/server/scoring/visibility.ts`):
`100 × (0.35·mentionRate + 0.25·positionScore + 0.20·shareOfVoice + 0.10·citationRate + 0.10·sentiment01)`, with
`positionScore = mean(1 / (1 + 0.5·(rank − 1)))` over mentioning answers, `shareOfVoice = brand mentions / tracked-brand mentions`,
`sentiment01 = (mean sentiment + 1)/2` (0.5 if mentioned but unscored, 0 if never mentioned). Weights via `VISIBILITY_WEIGHTS`; every snapshot stores `weightsVersion` (e.g. `w1:35-25-20-10-10`).

Worked example (unit test): 10 answers, mentioned in 6 at ranks 1,1,2,3,1,5, cited in 3, 25 tracked mentions, sentiments 0.5, 0.8, 0, —, 0.2, −0.5 →
mention 0.6 · position 0.75 · SoV 0.24 · citation 0.3 · sentiment 0.6 → 100 × (0.21 + 0.1875 + 0.048 + 0.03 + 0.06) = **53.6**.

**Snapshots** (`src/server/scoring/snapshots.ts`): per scan × market (country/language) × {all engines, each engine} × {primary, each active competitor}; written once per scan under a lock.

**History integrity**: `ResponseAnalysis`, `BrandMention`, `Citation`, `VisibilitySnapshot` reject UPDATE (trigger). Their FKs cascade only with project/organization deletion; competitors with history are deactivated, never deleted; providers/models referenced by answers are `RESTRICT`.

**Migrations**: `response_analysis`, `history_fk_actions`.

## 16. Phase 5 notes (as built)

**Metrics** (`src/server/dashboard`): every dashboard number is computed on request from the analyzed answers in the selected window (7d / 30d / 90d, previous period = the equal-length window before it), with the same `computeVisibility` the snapshots use. An integration test proves the 7-day score equals the latest scan's snapshot. Only answers whose analysis is at the current `analysisVersion` count, and only answers whose `isDemo` matches the workspace (demo and real data never mix).
- `aggregate.ts` is pure: per-subject metrics, daily series (scan days only, no gaps filled with invented values), per-prompt rows, prompt status, citation domains, "prompts they win", insights.
- `metrics.ts` authorizes (`requireProjectAccess`) and loads data; it is the only module the pages call.

**Prompt status** (from each engine's latest answer): WINNING = #1 in more than half of them · VISIBLE = mentioned in at least one · LOSING = absent while a competitor appears · NO_BRANDS · NOT_SCANNED.

**Citation gap** (third-party domains only, 0–100):
`100 × competitorShare × (1 − primaryShare) × ln(1 + n) / ln(1 + nmax)`, where the shares are the fractions of answers citing the domain that mention a competitor / you, and `n` is the number of answers citing it. It measures association, not cause, and the UI says so.

**"Why you may be losing"** insights describe what the answers contain (absent, outranked, sources used when you are absent, your site not cited, negative descriptions). They do not claim why engines chose them. Recommendations are deferred to the Action Engine.

**Pages**: Overview (hero score + delta, 4 metric cards, visibility trend + table view, per-engine scores, prompts you're losing, competitor table), Prompts (search + intent/engine/status/market filters), Prompt detail, Competitors (bar comparison, trend, metrics table, prompts they win), Citations (summary, top domains, citation gap).

**Charts** (Recharts): fixed categorical order `--series-1..6`, validated for light and dark. Slot 1 is always your brand, and competitors keep their slot across pages. One y-axis fixed at 0–100. A legend is always shown, plus a table view.

**Demo data** (`prisma/demo-data.ts`, non-production seed only): 8 weekly scans × prompts × 3 engines generated with a fixed-seed PRNG. Every answer is prefixed `[DEMO DATA]` and flagged `isDemo`, and all of it goes through the real analysis and snapshot code.

**Phase 5 review fix**: demo workspaces now refuse real scans (preview and server-side), since their dashboards only show demo data. A real scan there would cost money and its results would never be shown.

## 17. Phase 6 notes (as built)

**Opportunity engine** (`src/server/opportunities/rules.ts`, pure). It evaluates the last 30 days of analyzed answers after every analyzed scan (worker), or on demand with `pnpm admin opportunities <projectId>`.

| Type | Fires when |
| --- | --- |
| LOST_PROMPT | you're absent from every engine's latest answer, a competitor is present, and you're absent from ≥ 50% of the window's answers (≥ 2 answers) |
| POSITION_GAP | mentioned in ≥ 30% of answers but average position ≥ 2.5, or a competitor is listed above you in ≥ 60% of shared answers |
| CONTENT_GAP | a commercial/transactional/comparison/alternative prompt with priority ≥ 4, not won, and no crawled page targeting it (supersedes a position gap on the same prompt) |
| COMPETITOR_DOMINANCE | within one intent (≥ 2 prompts, ≥ 6 answers), a competitor's mention rate is ≥ 40%, ≥ 20 points above yours and ≥ 1.5× yours. Prompts that name the competitor ("HubSpot alternatives") are excluded for it |
| CITATION_GAP | a third-party domain with gap score ≥ 35 (Phase 5 formula), cited in ≥ 3 answers, and ≤ 50% of them mention you |

*Impact score* (0–100) is a priority signal, never a forecast. Lost prompt: `100 × (0.25·priority + 0.25·intent + 0.2·engine coverage + 0.2·leader score + 0.1·citation strength)`. The other types use the same ingredients (see code). Intent weights: transactional 1, commercial/comparison 0.9, alternative 0.85, branded 0.7, informational 0.4. *Confidence* = n/(n+5); content gaps are capped at 0.7 because page matching is heuristic.

*Page matching* (`pages.ts`): a page targets a prompt when ≥ 60% of the prompt's distinctive terms appear in its URL, title or H1. Category words found on most pages and filler words don't count. A prompt with no distinctive terms maps to the homepage.

**Action engine** (`recommend.ts`, deterministic templates). Every recommendation has WHAT (title), WHY (numbers from the evidence), WHERE (an existing page, or a suggested URL for a new one), HOW (steps) and EXPECTED IMPACT (HIGH ≥ 65 > MEDIUM ≥ 40 > LOW):

- *Lost prompt / content gap*:
  - a matching page exists → UPDATE_CONTENT + ADD_FAQ
  - comparison prompt → CREATE_COMPARISON_PAGE (`/compare/you-vs-x`)
  - alternatives prompt → CREATE_COMPARISON_PAGE (`/alternatives/x`, with migration steps)
  - branded → IMPROVE_ENTITY_CLARITY + ADD_SCHEMA
  - informational → CREATE_CONTENT + INTERNAL_LINKING
  - otherwise → CREATE_LANDING_PAGE + ADD_FAQ
- *Position gap*: UPDATE_CONTENT + INTERNAL_LINKING.
- *Dominance*: CREATE_COMPARISON_PAGE + DIGITAL_PR. Editorial sources only; review sites and communities get their own outreach.
- *Citation gap*, by source kind:
  - review sites → CITATION_OUTREACH (profile and honest reviews)
  - communities → CITATION_OUTREACH (with disclosure)
  - editorial → DIGITAL_PR
  - video → CREATE_CONTENT
  - encyclopedias → IMPROVE_ENTITY_CLARITY (no self-editing)
- *Wording*: no promises. Tests reject "guarantee", "will rank" and similar phrasing.

**Sync** (`service.ts`):
- Opportunities are keyed by fingerprint (`TYPE:subject`), so repeated scans update rather than duplicate.
- Dismissed opportunities stay dismissed. Opportunities no longer detected become RESOLVED ("No longer detected"), and come back to OPEN if detected again.
- A window with no answers changes nothing.
- Recommendations are unique per (opportunity, type). Only OPEN ones are rewritten.
- The same page or outreach coming from several opportunities is attached only to the highest-impact one; the others record `coveredBy`.

**Action tracking**: OPEN → PLANNED → IMPLEMENTED (date, URL, notes), or DISMISSED. Dismissing or reopening abandons a plan.
- *At implementation*: the scope is fixed (the opportunity's prompt(s), or the whole project), and the baseline is the visibility over the 30 days before the date.
- *After each analyzed scan*: an `ActionMeasurement` is stored (after-score over answers since implementation, at most 30 days, with sample size). Backdated implementations are backfilled from existing scans.
- *History*: measurements are append-only (DB trigger) and unique per (action, scan).
- *In the UI*: shown as "Observed change after implementation", with an explicit note that it isn't proof of cause.

**UI**:
- **Overview:** Top opportunities.
- **Opportunities:** status tabs, type filter, evidence, dismiss/restore.
- **Actions:** implemented with observed change / planned / recommended.
- **Recommendation detail:** why/where/how/impact, plan/implement form, before/after table.
- **Prompts table:** Opportunity column.
- **Prompt detail:** recommended actions.

**Demo seed**: each weekly demo scan is evaluated as of its date. In week 4 the top recommendation is implemented, so later scans show an observed before/after. The demo crawl pages are labelled `[DEMO]`.

**Migration**: `action_engine` (opportunity lifecycle timestamps, unique keys, action scope and baseline sample size, measurement sample size, append-only trigger, measurement→scan FK set to CASCADE).

**Phase 6 review fixes**:
- `plan` and `implement` lock the recommendation row, so concurrent clicks create exactly one action.
- Opportunities for prompts that are no longer tracked are hidden.

## 18. Phase 7 notes (as built)

The Gemini (Interactions API + Google Search grounding) and Perplexity (Agent API, pinned to `perplexity/sonar`) adapters are behind the same `AIAnswerProvider` interface. Shared HTTP and citation helpers are in `providers/http.ts`.

The provider differences are documented in [PROVIDERS.md](PROVIDERS.md):
- Gemini can't be localized by country. The UI says so on the scan confirmation and on each answer card.
- Gemini's redirect citations are resolved to real URLs.
- Perplexity uses `[n]` / `[web:n]` markers, maps them to search results, and reports its own billed cost.
- Search is billed per query for Gemini and per invocation for Perplexity.

The seed has current pricing; the retired `sonar` chat-completions model is deactivated. `pnpm scan:smoke` runs every ready engine.

Verified end to end against local stand-ins (documented response formats), through queue, worker, analysis, opportunities and dashboards. **Not verified against the live APIs** (no keys here).

**Phase 7 review**: no blocking issues in the adapters. The unenforced plan *project* limit found during review is fixed in Phase 8.

## 19. Phase 8 notes (as built)

Plans, server-side limits, Stripe Checkout, Billing Portal and webhooks, the billing page, and upgrade prompts are all built; see [BILLING.md](BILLING.md).
- **Effective tier:** canceled, unpaid, paused and incomplete subscriptions fall back to Free; past-due keeps the plan (grace).
- **Project limit:** enforced under a per-organization lock.
- **Downgrades:** only the oldest projects keep scanning.
- **Scan admission:** checks cadence and the monthly query allowance. Failed or cancelled scans no longer use up the daily manual-scan allowance.
- **Action Engine:** Growth and up, enforced in the service and shown as upgrade cards in the UI.
- **Webhook:** signature-verified, idempotent (`StripeEvent`), and re-fetches the subscription from Stripe.
- **Migration:** `stripe_events`.

Verified against stripe-mock (unit and integration tests, plus a browser run covering Checkout redirect, signed webhook and replay). **Not yet run against a real Stripe test-mode account** (no key here); see the checklist in BILLING.md.

## 20. Phase 9 notes (as built)

**Reports.** `buildProjectReport` assembles visibility, trend, competitor comparison, top winning and losing prompts, citation gaps, top opportunities and completed actions (observed before/after, labelled as observation, not proof).
- Share links (Agency plan, `report:share`): 256-bit random tokens, stored only as SHA-256. Shown once; optional expiry (7/30/90 days or never); revocable.
- Links pause if the plan lapses and resume if it's restored. View count and last view are recorded.
- `/r/[token]` is public, read-only, `noindex`, `no-referrer` and rate-limited per IP.
- White-label prep: `ReportShare.branding` (`agencyName`, `accentColor`) is rendered as "Prepared by …"; custom domains and logos can build on it later. Migration: `report_shares`.

**Free audit (`/audit`).** An acquisition funnel that runs a small real analysis:
- crawl ≤3 pages;
- brand and competitors via the onboarding model, or a guarded headline-based category fallback;
- 5 commercial-intent prompts on one engine (OpenAI preferred, else Perplexity, then Gemini);
- the same `analyzeResponse` and scoring as scans.

The page shows the score, the competitor comparison and the questions asked. The teaser shows counts only: lost prompts, citation opportunities, recommended actions (counted with the real recommendation templates). The lists themselves stay server-side.
- **Abuse and cost protection:**
  - feature flag and kill switch;
  - honeypot field;
  - HMAC form token (≥2 s fill time, ≤2 h age);
  - per-IP 3/hour and 10/day, counted in the DB on salted IP hashes (raw IPs are never stored), plus an in-process burst guard;
  - global `PUBLIC_AUDIT_DAILY_CAP` (default 50);
  - 24 h per-domain reuse (repeat requests cost nothing);
  - its own `public-audit` queue (concurrency 2, no retries) so anonymous traffic never delays customer scans.
- **Conversion:** "Create free account" → `/sign-up?audit=<id>` → `/audit/<id>/continue`, which records `convertedTo` and opens onboarding with the domain and market prefilled. Conversions are counted in admin.
- **Cost:** engine cost is stored on the audit (`result.costUsd`) and shown in admin. Audit queries don't count against provider daily caps; they're bounded by the global cap (≤5 queries each).

**Admin (`/admin`).** Platform admins only (`User.isPlatformAdmin`, set from `PLATFORM_ADMIN_EMAILS`). Everyone else gets a 404.
- **Overview:**
  - the global scan kill switch, with a reason required to turn it on;
  - counts;
  - estimated AI cost over 30 days (scans, onboarding, audits; daily chart);
  - provider usage, readiness and enable/disable;
  - subscriptions by plan and status, with the effective tier;
  - the audit funnel.
- **Lists:** organizations, users, projects, scans (searchable, latest 50).
- **Failed jobs:** query jobs (grouped by error code), failed scans and analyses, failed audits.
- Demo data is excluded from usage and cost. All changes are audit-logged.

**Polish.** A public landing page at `/` (signed-in users still go straight to their workspace), a shared public header and footer, and onboarding prefill (`?url=&country=`).

