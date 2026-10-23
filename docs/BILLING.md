# Plans and billing

## Plans (`src/server/billing/plans.ts`)

| | Free | Starter $49 | Growth $149 | Agency $499 |
| --- | --- | --- | --- | --- |
| Projects | 1 | 1 | 3 | 10 |
| Prompts per project | 10 | 50 | 200 | 1,000 |
| Scan cadence per project | weekly | weekly | daily (20 h) | daily (20 h) |
| Manual scans / day (org) | 1 | 3 | 10 | 50 |
| AI queries / day (org) | 50 | 300 | 2,000 | 10,000 |
| AI queries / month (org) | 150 | 1,000 | 25,000 | 100,000 |
| Recommendations & action tracking | — | — | ✓ | ✓ |
| Reports & team features (Phase 9) | — | — | — | ✓ |

The query caps are the cost guard. At roughly $0.02–0.05 per grounded query, Growth's monthly cap is worth up to about $1,250 of provider spend. Tune the caps against real provider costs before launch. Platform caps (`SCAN_ORG_DAILY_QUERY_CAP`, `SCAN_GLOBAL_DAILY_QUERY_CAP`, per-provider caps) and the kill switch still apply on top of every plan.

## Enforcement (server-side only; the UI mirrors it)

**The plan that applies.** It is `effectiveTier(subscription)`:
- `ACTIVE`, `TRIALING` and `PAST_DUE` (Stripe's retry grace period) keep the paid plan.
- `CANCELED`, `UNPAID` (incl. Stripe `paused`) and `INCOMPLETE` get Free limits.

Data is never deleted on a downgrade.

**Projects.** Checked in `createProject` under a per-organization advisory lock, so concurrent creations can't exceed the limit. After a downgrade, only the oldest projects up to the limit keep scanning; the rest stay readable.

**Scans.** Scan admission (inside its locked transaction) checks:
- active prompts against the plan limit;
- whether the project is within the plan;
- cadence since the last scan that ran (failed or cancelled scans don't count);
- manual scans per day;
- monthly and daily queries (planned jobs; skipped jobs never count).

The worker's runtime quota re-checks the daily cap before every paid call. The scan preview runs the same checks read-only and says why a scan is blocked, with a "See plans" link when an upgrade would lift it.

**Prompts.** Approving prompts in onboarding is capped at the plan's limit.

**Action Engine.** Recommendations, plans, implementations and measurements are refused with `FEATURE_DISABLED` below Growth. Opportunities stay visible on every plan, and recommendations keep being generated so they appear immediately after an upgrade.

**Usage.** `UsageRecord` rows are written for scans, provider queries (with cost), crawled pages and AI extractions. The billing page shows usage against limits.

## Stripe

Stripe is the source of truth.
- **Checkout** creates subscriptions. The Stripe customer is created once per organization, with an idempotency key.
- **The Billing Portal** handles plan changes, payment methods and cancellation.
- **The webhook** (`POST /api/stripe/webhook`):
  - verifies the signature against the raw body;
  - records each event id in `StripeEvent`, so redeliveries are no-ops;
  - re-fetches the subscription from Stripe on every relevant event, so out-of-order delivery converges on the current state.
- **Mapping.** A price is mapped to a plan only through the configured price ids, so an unknown price never grants a paid plan. An old, ended subscription can't overwrite a different, still-paid one.
- **Returning from Checkout.** The session is checked to belong to the organization, then the plan syncs immediately rather than waiting for the webhook.
- **Permissions.** Only the organization **owner** (`billing:manage`) can start Checkout or open the portal.

### Setup (test mode first)

1. In Stripe (test mode), create a product with three monthly prices: Starter $49, Growth $149, Agency $499. Put their ids in `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_GROWTH` and `STRIPE_PRICE_AGENCY`.
2. Set `STRIPE_SECRET_KEY` to `sk_test_…`.
3. Add a webhook endpoint `https://<app>/api/stripe/webhook` with these events:
   - `checkout.session.completed`;
   - `customer.subscription.created|updated|deleted|paused|resumed`;
   - `invoice.paid`, `invoice.payment_failed`.

   Put its signing secret in `STRIPE_WEBHOOK_SECRET`.

   Locally, use `stripe listen --forward-to localhost:3000/api/stripe/webhook` instead.
4. In Billing Portal settings:
   - allow switching between the three prices;
   - allow cancellation (at period end);
   - allow payment-method updates.
5. Set `FEATURE_BILLING="true"`. The billing page shows a "Stripe test mode" badge while a test key is used.
6. Check it end to end:
   1. Choose Growth.
   2. Pay with card `4242 4242 4242 4242`.
   3. You should return to the billing page on Growth.
   4. Cancel in Manage billing. After the period ends, Stripe sends `customer.subscription.deleted` and Free limits apply.
   5. Card `4000 0000 0000 0341` simulates a failed renewal (→ `PAST_DUE`).

With billing off, plans can be set by hand: `pnpm admin plan <orgSlug> GROWTH`. This is refused while a live Stripe subscription exists.

### Tests

- **Unit:** mapping (statuses, periods on subscription items, unknown prices, the stale-subscription rule, invoice shapes).
- **Integration:** run against **stripe-mock**, Stripe's official API mock, which validates every request against Stripe's OpenAPI spec. They cover:
  - Checkout, customer reuse, owner-only access, existing subscribers sent to the portal;
  - billing off or unconfigured;
  - webhook signatures, plan sync, and idempotency on replay.

```
go install github.com/stripe/stripe-mock@latest
stripe-mock -http-port 12111 &
pnpm test:integration
```

`STRIPE_API_BASE` points the SDK at stripe-mock. It is honoured only for loopback addresses, so it can't redirect real billing traffic.
