import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { mapSubscription, shouldApply, stripeEnv, subscriptionIdOf, tierForPrice } from "@/server/billing/stripe-mapping";

const cfg = { secretKey: "sk_test_x", webhookSecret: "whsec_x", prices: { STARTER: "price_s", GROWTH: "price_g", AGENCY: "price_a" } };
const sub = (o: Record<string, unknown>) => ({ id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, metadata: {}, items: { data: [{ price: { id: "price_g" }, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000 }] }, ...o }) as unknown as Stripe.Subscription;

describe("mapSubscription", () => {
  it("maps price → tier, status, and periods from the subscription item (API ≥ 2025-03-31)", () => {
    const m = mapSubscription(sub({}), cfg);
    expect(m.tier).toBe("GROWTH");
    expect(m.data).toMatchObject({ planTier: "GROWTH", status: "ACTIVE", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1", stripePriceId: "price_g", cancelAtPeriodEnd: false });
    expect(m.data.currentPeriodEnd?.toISOString()).toBe(new Date(1_792_600_000_000).toISOString());
  });

  it("falls back to legacy top-level periods; maps every Stripe status", () => {
    const legacy = mapSubscription(sub({ items: { data: [{ price: { id: "price_a" } }] }, current_period_end: 1_800_000_000 }), cfg);
    expect(legacy.data).toMatchObject({ planTier: "AGENCY", currentPeriodEnd: new Date(1_800_000_000_000) });
    const expected: Record<string, string> = { active: "ACTIVE", trialing: "TRIALING", past_due: "PAST_DUE", incomplete: "INCOMPLETE", unpaid: "UNPAID", paused: "UNPAID", canceled: "CANCELED", incomplete_expired: "CANCELED", something_new: "UNPAID" };
    for (const [stripe, ours] of Object.entries(expected)) expect(mapSubscription(sub({ status: stripe }), cfg).data.status).toBe(ours);
  });

  it("an unknown price never grants a paid plan", () => {
    const m = mapSubscription(sub({ items: { data: [{ price: { id: "price_other" } }] } }), cfg);
    expect(m.tier).toBeNull();
    expect(m.data.planTier).toBe("FREE");
    expect(tierForPrice(null, cfg)).toBeNull();
  });
});

describe("shouldApply", () => {
  const paid = { stripeSubscriptionId: "sub_new", planTier: "GROWTH" as const, status: "ACTIVE" as const };
  it("an old, ended subscription can't overwrite a different paid one", () => {
    expect(shouldApply(paid, { stripeSubscriptionId: "sub_old", planTier: "STARTER", status: "CANCELED" })).toBe(false);
  });
  it("updates to the same subscription, new paid subscriptions and first links always apply", () => {
    expect(shouldApply(paid, { stripeSubscriptionId: "sub_new", planTier: "GROWTH", status: "CANCELED" })).toBe(true);
    expect(shouldApply({ ...paid, status: "CANCELED" }, { stripeSubscriptionId: "sub_other", planTier: "AGENCY", status: "ACTIVE" })).toBe(true);
    expect(shouldApply({ stripeSubscriptionId: null, planTier: "FREE", status: "ACTIVE" }, { stripeSubscriptionId: "sub_1", planTier: "STARTER", status: "ACTIVE" })).toBe(true);
  });
});

describe("subscriptionIdOf", () => {
  const ev = (type: string, object: Record<string, unknown>) => ({ id: "evt", type, data: { object } }) as unknown as Stripe.Event;
  it("finds the subscription on checkout, subscription and invoice events (new and old invoice shapes)", () => {
    expect(subscriptionIdOf(ev("checkout.session.completed", { subscription: "sub_1", client_reference_id: "org_1" }))).toEqual({ subscriptionId: "sub_1", organizationId: "org_1" });
    expect(subscriptionIdOf(ev("customer.subscription.deleted", { id: "sub_2", metadata: { organizationId: "org_2" } }))).toEqual({ subscriptionId: "sub_2", organizationId: "org_2" });
    expect(subscriptionIdOf(ev("invoice.payment_failed", { parent: { subscription_details: { subscription: "sub_3" } } })).subscriptionId).toBe("sub_3");
    expect(subscriptionIdOf(ev("invoice.paid", { subscription: { id: "sub_4" } })).subscriptionId).toBe("sub_4");
    expect(subscriptionIdOf(ev("customer.created", { id: "cus_1" })).subscriptionId).toBeNull();
  });
});

describe("stripeEnv", () => {
  it("only honours a loopback STRIPE_API_BASE (stripe-mock), never a remote host", () => {
    expect(stripeEnv({ STRIPE_API_BASE: "http://localhost:12111" } as unknown as NodeJS.ProcessEnv).apiBase).toBe("http://localhost:12111");
    expect(stripeEnv({ STRIPE_API_BASE: "https://evil.example" } as unknown as NodeJS.ProcessEnv).apiBase).toBeUndefined();
    expect(stripeEnv({} as unknown as NodeJS.ProcessEnv).apiBase).toBeUndefined();
  });
});
