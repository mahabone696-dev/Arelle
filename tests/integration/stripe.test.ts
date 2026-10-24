/**
 * Stripe flows against stripe-mock (Stripe's official API mock: every request
 * is validated against Stripe's OpenAPI spec). Run it with
 *   go install github.com/stripe/stripe-mock@latest && stripe-mock -http-port 12111
 * Tests are skipped (loudly) when it isn't running.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { db } from "@/server/db";
import { createOrganization } from "@/server/organizations/service";
import { confirmCheckout, createCheckoutSession, createPortalSession, handleWebhook, syncSubscription, type StripeEnv } from "@/server/billing/stripe";
import { getOrgPlan } from "@/server/billing/limits";

const MOCK = process.env.STRIPE_MOCK_URL ?? "http://localhost:12111";
// stripe-mock returns this fixed price on every subscription.
const MOCK_PRICE = "price_1PgafmB7WZ01zgkW6dKueIc5";
const cfg: StripeEnv = { secretKey: "sk_test_mock", webhookSecret: "whsec_test_secret", apiBase: MOCK, prices: { STARTER: "price_starter_test", GROWTH: MOCK_PRICE, AGENCY: "price_agency_test" } };

let mockUp = false;
beforeAll(async () => {
  mockUp = await fetch(`${MOCK}/v1/customers`, { headers: { authorization: "Bearer sk_test_mock" } }).then((r) => r.ok).catch(() => false);
  if (!mockUp) console.warn(`\n⚠ stripe-mock is not running at ${MOCK}: Stripe integration tests skipped.\n`);
  process.env.FEATURE_BILLING = "true";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
});
afterEach(() => {
  process.env.FEATURE_BILLING = "true";
});

async function owner() {
  const user = await db.user.create({ data: { email: `own${Math.random()}@t.com` } });
  const org = await createOrganization(user.id, { name: "Paying Co" });
  return { user, org };
}

function signed(event: object) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: cfg.webhookSecret! });
  return { payload, header };
}

describe("Stripe (stripe-mock)", () => {
  it("checkout: owner only, creates the customer once, returns a Checkout URL; existing subscribers go to the portal", async (t) => {
    if (!mockUp) t.skip();
    const { user, org } = await owner();
    const { url } = await createCheckoutSession(user.id, org.id, "GROWTH", cfg);
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const sub = await db.subscription.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(sub.stripeCustomerId).toMatch(/^cus_/);
    await createCheckoutSession(user.id, org.id, "STARTER", cfg);
    expect((await db.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })).stripeCustomerId).toBe(sub.stripeCustomerId);

    const member = await db.user.create({ data: { email: `m${Math.random()}@t.com` } });
    await db.organizationMember.create({ data: { organizationId: org.id, userId: member.id, role: "ADMIN" } });
    await expect(createCheckoutSession(member.id, org.id, "GROWTH", cfg)).rejects.toMatchObject({ code: "FORBIDDEN" });

    await db.subscription.update({ where: { organizationId: org.id }, data: { planTier: "GROWTH", status: "ACTIVE", stripeSubscriptionId: "sub_existing" } });
    await expect(createCheckoutSession(user.id, org.id, "AGENCY", cfg)).rejects.toMatchObject({ code: "CONFLICT" });
    const portal = await createPortalSession(user.id, org.id, cfg);
    expect(portal.url).toMatch(/^https:\/\//);
  });

  it("billing switched off or unconfigured → transparent errors, nothing is created", async (t) => {
    if (!mockUp) t.skip();
    const { user, org } = await owner();
    process.env.FEATURE_BILLING = "false";
    await expect(createCheckoutSession(user.id, org.id, "GROWTH", cfg)).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    process.env.FEATURE_BILLING = "true";
    await expect(createCheckoutSession(user.id, org.id, "GROWTH", { ...cfg, prices: { GROWTH: MOCK_PRICE } })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(createPortalSession(user.id, org.id, cfg)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await db.subscription.findUniqueOrThrow({ where: { organizationId: org.id } })).stripeCustomerId).toBeNull();
  });

  it("webhook: verifies the signature, syncs the plan from Stripe, and is idempotent", async (t) => {
    if (!mockUp) t.skip();
    const { org } = await owner();
    const event = { id: "evt_sync_1", object: "event", type: "customer.subscription.updated", created: 1, data: { object: { id: "sub_123", object: "subscription", customer: "cus_unknown", metadata: { organizationId: org.id } } } };

    expect(await handleWebhook(JSON.stringify(event), "t=1,v1=bad", cfg)).toMatchObject({ status: 400 });
    expect(await handleWebhook(JSON.stringify(event), null, { ...cfg, webhookSecret: undefined })).toMatchObject({ status: 503 });
    expect((await getOrgPlan(org.id)).tier).toBe("FREE");

    const { payload, header } = signed(event);
    expect(await handleWebhook(payload, header, cfg)).toEqual({ status: 200, body: { received: true } });
    const sub = await db.subscription.findUniqueOrThrow({ where: { organizationId: org.id } });
    expect(sub).toMatchObject({ planTier: "GROWTH", status: "ACTIVE", stripeSubscriptionId: "sub_123", stripePriceId: MOCK_PRICE });
    expect(sub.stripeCustomerId).toMatch(/^cus_/);
    expect(sub.currentPeriodEnd).toBeInstanceOf(Date);
    expect((await getOrgPlan(org.id)).tier).toBe("GROWTH");

    expect(await handleWebhook(payload, header, cfg)).toEqual({ status: 200, body: { received: true, duplicate: true } });
    expect(await db.auditLog.count({ where: { organizationId: org.id, action: "billing.subscription_changed" } })).toBe(1);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_sync_1" } })).toMatchObject({ processedAt: expect.any(Date), error: null });
  });

  it("an unknown price never grants a paid plan; unrelated events are acknowledged", async (t) => {
    if (!mockUp) t.skip();
    const { org } = await owner();
    await db.subscription.update({ where: { organizationId: org.id }, data: { stripeSubscriptionId: "sub_123" } });
    await syncSubscription("sub_123", {}, { ...cfg, prices: { STARTER: "a", GROWTH: "b", AGENCY: "c" } });
    expect((await getOrgPlan(org.id)).tier).toBe("FREE");
    const { payload, header } = signed({ id: "evt_other", object: "event", type: "customer.created", data: { object: { id: "cus_1" } } });
    expect(await handleWebhook(payload, header, cfg)).toMatchObject({ status: 200 });
  });

  it("returning from Checkout syncs immediately, only for the organization's own session", async (t) => {
    if (!mockUp) t.skip();
    const { user, org } = await owner();
    // stripe-mock echoes the client_reference_id of the retrieved session only when set; a foreign session is ignored.
    expect(await confirmCheckout(user.id, org.id, "cs_test_foreign", cfg)).toBeNull();
    expect(await confirmCheckout(user.id, org.id, "not-a-session-id", cfg)).toBeNull();
    expect((await getOrgPlan(org.id)).tier).toBe("FREE");
  });
});
