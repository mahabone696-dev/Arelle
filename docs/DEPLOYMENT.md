# Deployment

The app is two processes plus two managed services:

| Component | What it does |
| --- | --- |
| `arelle-web` | Next.js app (UI, auth, onboarding, enqueueing scans) |
| `arelle-worker` | BullMQ worker: runs scans, calls OpenAI, analyzes answers |
| Postgres | All data |
| Redis (Key Value) | Job queue + daily query counters (**must use `noeviction`**) |

## Render (recommended Vercel alternative)

`render.yaml` defines everything as a Blueprint.

1. Push this repository to GitHub (already done for branch `claude/ai-search-visibility-saas-teq4s4`).
2. In Render: **New → Blueprint**, connect the GitHub repo, choose the branch above, and confirm.
3. When prompted, fill in the secrets:
   - `OPENAI_API_KEY` — asked for twice (web and worker); use the same key.
   - `GEMINI_API_KEY`, `PERPLEXITY_API_KEY` — optional, also asked for twice. To turn an engine on, also set `FEATURE_GEMINI` / `FEATURE_PERPLEXITY` to `"true"` in the `arelle-shared` group and run `pnpm admin provider enable gemini|perplexity` (Render Shell). See [PROVIDERS.md](PROVIDERS.md).
   - `SIGNUP_ALLOWLIST` — e.g. `you@company.com` or `@company.com`. **Keep this set** on a public URL, otherwise anyone can sign up and spend your OpenAI credit.
   - `PLATFORM_ADMIN_EMAILS` — your email (optional).
4. Wait for the first deploy. The web service runs migrations and seeds providers/model pricing on start, then serves `https://arelle-web-xxxx.onrender.com`.
5. Sign up with an allow-listed email and go through onboarding.

Cost: web, Postgres and Key Value are on free plans. **Render has no free plan for background workers**; the worker uses the smallest paid instance. Free web services sleep when idle (first request takes ~1 minute). Free Postgres has a limited lifetime on Render — upgrade it to keep data.

### Preview safety limits (in `render.yaml`, group `arelle-shared`)

| Variable | Preview value | Meaning |
| --- | --- | --- |
| `SCAN_GLOBAL_DAILY_QUERY_CAP` | 200 | Paid OpenAI queries per day across all users (≈ $6 at seeded prices) |
| `SCAN_ORG_DAILY_QUERY_CAP` | 100 | Per organization per day (plan limits also apply) |
| `SCAN_MAX_QUERIES_PER_SCAN` | 100 | Per scan |

New sign-ups get the FREE plan (10 prompts, 1 manual scan/day). There is no billing UI yet (Phase 8); to give your own workspace a bigger plan, run in the Render web service shell:

```bash
psql "$DATABASE_URL" -c "UPDATE \"Subscription\" SET \"planTier\"='GROWTH' WHERE \"organizationId\"=(SELECT id FROM \"Organization\" WHERE slug='<your-workspace-slug>')"
```

### Operations (Render shell on `arelle-web`)

```bash
pnpm admin kill-switch on "reason"   # stop all paid queries immediately
pnpm admin kill-switch off
pnpm admin provider status            # why each AI engine is (un)available
pnpm admin analyze <scanId>           # re-run analysis for a scan
```

## Other hosts

Any platform that runs a long-lived Node process works (Railway, Fly.io, a VM). Requirements:
Node 22, `pnpm install && pnpm build` → `pnpm db:deploy && NODE_ENV=production pnpm db:seed && pnpm start` for web;
`pnpm install && pnpm worker:build` → `pnpm worker:start` for the worker; Postgres 16+; Redis 7 with `maxmemory-policy noeviction`.
Set `AUTH_URL` to the public URL when the host doesn't provide `RENDER_EXTERNAL_URL`.
