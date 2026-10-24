# Arelle — AI Search Visibility (GEO)

Understand and improve how a brand appears in AI-generated answers:
**Discover → Track → Diagnose → Recommend → Fix → Measure → Repeat.**

Architecture, data model and the phased build plan live in
[`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS 4 · shadcn/ui · PostgreSQL ·
Prisma 7 · Auth.js v5 · Zod · Vitest · Redis/BullMQ workers · Recharts · Stripe.
Answer engines: OpenAI, Gemini, Perplexity (see [`docs/PROVIDERS.md`](docs/PROVIDERS.md)).

## Local development

Requirements: Node ≥ 22.12, pnpm 10, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL and AUTH_SECRET
pnpm db:migrate               # apply migrations
pnpm db:seed                  # providers, feature flags, and a DEMO workspace
pnpm dev                      # web app
pnpm worker:dev               # background workers (scans, analysis, free audits) — needs REDIS_URL
```

Public pages: `/` (landing), `/audit` (free audit, `FEATURE_PUBLIC_AUDIT="true"`),
`/r/<token>` (shared reports). Platform admins (emails in `PLATFORM_ADMIN_EMAILS`)
get `/admin`, including the global scan kill switch.

The seed creates a clearly labelled demo workspace (`demo@arelle.dev` /
`demo-password-123`, override with `SEED_DEMO_PASSWORD`). Demo data is never
seeded in production.

## Deploying

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — one-click Render Blueprint (`render.yaml`) for web, worker, Postgres and Redis.

## Scripts

| Command | Purpose |
| --- | --- |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` | Unit tests (`tests/unit`) |
| `pnpm test:integration` | DB-backed tests against `TEST_DATABASE_URL` (default `postgresql://geo:geo@localhost:5432/geo_test`) |
| `pnpm build` | Production build |
| `pnpm db:migrate` / `db:deploy` | Create/apply migrations (dev) / apply only (prod) |

## Layout

- `src/app` — routes and UI only.
- `src/server` — business logic (framework-agnostic, shared by web and worker).
- `worker` — BullMQ worker entry point.
- `src/lib` — shared utilities (logger, monitoring, domain validation, i18n).
- `prisma` — schema, migrations, seed.
