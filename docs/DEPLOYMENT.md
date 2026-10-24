# Deployment

The app is two processes plus two managed services:

| Component | What it does |
| --- | --- |
| `arelle-web` | Next.js app (UI, auth, onboarding, enqueueing scans) |
| `arelle-worker` | BullMQ worker: runs scans, calls the AI engines, analyzes answers, runs free audits |
| Postgres | All data |
| Redis (Key Value) | Job queue + daily query counters (**must use `noeviction`**) |

## Render (recommended Vercel alternative)

`render.yaml` defines everything as a Blueprint.

1. Push this repository to GitHub (already done for branch `claude/ai-search-visibility-saas-teq4s4`).
2. In Render: **New → Blueprint**, connect the GitHub repo, and choose the branch above. The repo's default branch doesn't contain the app yet, so pick this branch explicitly (or merge PR #2 first). Confirm.
3. When prompted, fill in the secrets:
   - `OPENAI_API_KEY` — asked for twice (web and worker); use the same key.
   - `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` — optional, also asked for twice. To turn an engine on, also set `FEATURE_GEMINI` / `FEATURE_PERPLEXITY` to `"true"` in the `arelle-shared` group and run `pnpm admin provider enable gemini|perplexity` (Render Shell). See [PROVIDERS.md](PROVIDERS.md).
   - `SIGNUP_ALLOWLIST` — e.g. `you@company.com` or `@company.com`. **Keep this set** on a public URL, otherwise anyone can sign up and spend your OpenAI credit.
   - `PLATFORM_ADMIN_EMAILS` — your email. Set it **before** you sign up: admin rights are granted at sign-up. It gives you `/admin` (kill switch, provider toggles, costs, failed jobs).
   - Stripe keys — leave empty for now if you're not charging yet (see [Billing](#billing) below).
4. Wait for the first deploy. The web service runs migrations and seeds providers/model pricing on start, then serves `https://arelle-web-xxxx.onrender.com`.
5. Sign up with an allow-listed email and go through onboarding.

Cost: web, Postgres and Key Value are on free plans. **Render has no free plan for background workers**; the worker uses the smallest paid instance. Free web services sleep when idle (first request takes ~1 minute). Free Postgres has a limited lifetime on Render — upgrade it to keep data.

### Preview safety limits (in `render.yaml`, group `arelle-shared`)

| Variable | Preview value | Meaning |
| --- | --- | --- |
| `SCAN_GLOBAL_DAILY_QUERY_CAP` | 200 | Paid OpenAI queries per day across all users (≈ $6 at seeded prices) |
| `SCAN_ORG_DAILY_QUERY_CAP` | 100 | Per organization per day (plan limits also apply) |
| `SCAN_MAX_QUERIES_PER_SCAN` | 100 | Per scan |

New sign-ups get the FREE plan (10 prompts, 1 manual scan/day). While billing is off, give your own workspace a bigger plan from a shell (below):

```bash
pnpm admin plan <your-workspace-slug> GROWTH
```

### Billing

Set `STRIPE_SECRET_KEY`, the three `STRIPE_PRICE_*` IDs and `STRIPE_WEBHOOK_SECRET`, then `FEATURE_BILLING="true"` in `arelle-shared`. In Stripe, add a webhook endpoint `https://<your-app>.onrender.com/api/stripe/webhook` (events listed in [BILLING.md](BILLING.md)). Use test-mode keys first.

### Optional features (group `arelle-shared`)

- `FEATURE_PUBLIC_AUDIT="true"` opens the free `/audit` page to anyone (each audit costs up to 5 queries; capped by `PUBLIC_AUDIT_DAILY_CAP`, 20 in the blueprint). It ignores `SIGNUP_ALLOWLIST`, so turn it on only when you're ready for public traffic.
- `FEATURE_REPORTS` (on by default) — Agency-plan share links.

### Operations

Day to day, use `/admin` in the app: the global scan kill switch, provider enable/disable, costs and failed jobs.

For the commands below, open **Shell** on `arelle-worker` (Render has no shell on free web instances; the worker is a paid instance and has the same database access):

```bash
pnpm admin kill-switch on "reason"   # stop all paid queries immediately (also in /admin)
pnpm admin kill-switch off
pnpm admin plan <workspace-slug> GROWTH   # set a plan manually while billing is off
pnpm admin provider status            # why each AI engine is (un)available
pnpm admin analyze <scanId>           # re-run analysis for a scan
```

## Other hosts

Any platform that runs a long-lived Node process works (Railway, Fly.io, a VM). Requirements:
Node 22, `pnpm install && pnpm build` → `pnpm db:deploy && NODE_ENV=production pnpm db:seed && pnpm start` for web;
`pnpm install && pnpm worker:build` → `pnpm worker:start` for the worker; Postgres 16+; Redis 7 with `maxmemory-policy noeviction`.
Set `AUTH_URL` to the public URL when the host doesn't provide `RENDER_EXTERNAL_URL`.
