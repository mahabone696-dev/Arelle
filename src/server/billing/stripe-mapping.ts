/**
 * Pure Stripe ↔ Arelle mapping (no I/O): price → tier, Stripe status →
 * SubscriptionStatus, billing periods, which subscription an event is about,
 * and whether an incoming subscription may overwrite the stored one.
 */
import type Stripe from "stripe";
import type { PlanTier, SubscriptionStatus } from "@/generated/prisma/enums";
import { effectiveTier, PAID_TIERS, type PaidTier } from "./plans";

export interface StripeEnv {
  secretKey?: string;
  webhookSecret?: string;
  prices: Partial<Record<PaidTier, string>>;
  /** Test seam: e.g. http://localhost:12111 for stripe-mock. */
  apiBase?: string;
}

/** STRIPE_API_BASE is for stripe-mock in tests: only loopback addresses are honoured, so it can't redirect real billing traffic. */
function localOnly(base: string | undefined) {
  if (!base) return undefined;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname) ? base : undefined;
  } catch {
    return undefined;
  }
}

export function stripeEnv(env: NodeJS.ProcessEnv = process.env): StripeEnv {
  return {
    secretKey: env.STRIPE_SECRET_KEY || undefined,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || undefined,
    prices: {
      STARTER: env.STRIPE_PRICE_STARTER || undefined,
      GROWTH: env.STRIPE_PRICE_GROWTH || undefined,
      AGENCY: env.STRIPE_PRICE_AGENCY || undefined,
    },
    apiBase: localOnly(env.STRIPE_API_BASE),
  };
}

export const isTestMode = (cfg: StripeEnv = stripeEnv()) =>
  Boolean(cfg.secretKey?.startsWith("sk_test_") || cfg.secretKey?.startsWith("rk_test_"));

export function tierForPrice(
  priceId: string | null | undefined,
  cfg: StripeEnv = stripeEnv(),
): PaidTier | null {
  if (!priceId) return null;
  return PAID_TIERS.find((t) => cfg.prices[t] === priceId) ?? null;
}

const STATUS: Record<string, SubscriptionStatus> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  incomplete: "INCOMPLETE",
  unpaid: "UNPAID",
  // Paused subscriptions collect no payment: no paid features until resumed.
  paused: "UNPAID",
  canceled: "CANCELED",
  incomplete_expired: "CANCELED",
};

type StripeSub = Stripe.Subscription;
export const idOf = (v: string | { id: string } | null | undefined) =>
  typeof v === "string" ? v : (v?.id ?? null);

/** Pure mapping from a Stripe subscription to our row (exported for tests). */
export function mapSubscription(sub: StripeSub, cfg: StripeEnv = stripeEnv()) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const tier = tierForPrice(priceId, cfg);
  // Billing periods live on subscription items since API version 2025-03-31.
  const legacy = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const start = item?.current_period_start ?? legacy.current_period_start;
  const end = item?.current_period_end ?? legacy.current_period_end;
  return {
    tier,
    data: {
      planTier: (tier ?? "FREE") as PlanTier,
      status: STATUS[sub.status] ?? ("UNPAID" as SubscriptionStatus),
      stripeSubscriptionId: sub.id,
      stripeCustomerId: idOf(sub.customer),
      stripePriceId: priceId,
      currentPeriodStart: start ? new Date(start * 1000) : null,
      currentPeriodEnd: end ? new Date(end * 1000) : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    },
  };
}

/**
 * Whether a Stripe subscription may overwrite the organization's row: an old,
 * ended subscription must never replace a different one that is still paid.
 */
export function shouldApply(
  row: { stripeSubscriptionId: string | null; planTier: PlanTier; status: SubscriptionStatus },
  incoming: { stripeSubscriptionId: string; planTier: PlanTier; status: SubscriptionStatus },
) {
  const replacingOther =
    row.stripeSubscriptionId !== null && row.stripeSubscriptionId !== incoming.stripeSubscriptionId;
  return !(replacingOther && effectiveTier(row) !== "FREE" && effectiveTier(incoming) === "FREE");
}

/** Subscription id an event refers to, if any. */
export function subscriptionIdOf(event: Stripe.Event): {
  subscriptionId: string | null;
  organizationId: string | null;
} {
  const o = event.data.object as unknown as Record<string, unknown>;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
      return {
        subscriptionId: idOf(o.subscription as string | { id: string } | null),
        organizationId: (o.client_reference_id as string | null) ?? null,
      };
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.trial_will_end":
      return {
        subscriptionId: o.id as string,
        organizationId:
          ((o.metadata as Record<string, string> | undefined)?.organizationId as string) ?? null,
      };
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      // API ≥ 2025-03-31: invoice.parent.subscription_details.subscription; older: invoice.subscription.
      const parent = o.parent as
        { subscription_details?: { subscription?: string | { id: string } } } | undefined;
      return {
        subscriptionId: idOf(
          parent?.subscription_details?.subscription ??
            (o.subscription as string | { id: string } | null),
        ),
        organizationId: null,
      };
    }
    default:
      return { subscriptionId: null, organizationId: null };
  }
}
