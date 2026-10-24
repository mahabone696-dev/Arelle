/**
 * Stripe integration: Checkout for new subscriptions, the Billing Portal for
 * changes/cancellation, and webhook-driven sync of the Subscription row.
 *
 * Stripe is the source of truth. Webhooks are verified, deduplicated by event
 * id, and every relevant event re-fetches the subscription from Stripe, so
 * out-of-order or replayed deliveries converge on the current state.
 */
import Stripe from "stripe";
import { db } from "@/server/db";
import { requireOrgAccess } from "@/server/auth/authorization";
import { isFeatureEnabled } from "@/server/flags/flags";
import { writeAuditLog } from "@/server/audit-log/audit-log";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { appOrigin } from "@/lib/signup-policy";
import { effectiveTier, PAID_TIERS, tierName, type PaidTier } from "./plans";
import {
  idOf,
  isTestMode,
  mapSubscription,
  shouldApply,
  stripeEnv,
  subscriptionIdOf,
  type StripeEnv,
} from "./stripe-mapping";

export {
  isTestMode,
  mapSubscription,
  shouldApply,
  stripeEnv,
  subscriptionIdOf,
  tierForPrice,
  type StripeEnv,
} from "./stripe-mapping";

const log = logger.child({ module: "billing" });

let cached: { key: string; client: Stripe } | null = null;
export function stripeClient(cfg: StripeEnv = stripeEnv()): Stripe {
  if (!cfg.secretKey) throw new AppError("UNAVAILABLE", "Billing is not configured.");
  if (cached?.key === `${cfg.secretKey}|${cfg.apiBase ?? ""}`) return cached.client;
  const base = cfg.apiBase ? new URL(cfg.apiBase) : null;
  const client = new Stripe(cfg.secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: "Arelle" },
    ...(base
      ? {
          host: base.hostname,
          port: base.port || (base.protocol === "https:" ? 443 : 80),
          protocol: base.protocol.replace(":", "") as "http" | "https",
        }
      : {}),
  });
  cached = { key: `${cfg.secretKey}|${cfg.apiBase ?? ""}`, client };
  return client;
}

export async function billingAvailability(cfg: StripeEnv = stripeEnv()) {
  const enabled = await isFeatureEnabled("billing");
  const configured = Boolean(
    cfg.secretKey && cfg.webhookSecret && PAID_TIERS.every((t) => cfg.prices[t]),
  );
  return { enabled, configured, ready: enabled && configured, testMode: isTestMode(cfg) };
}

async function requireBilling(userId: string, organizationId: string, cfg: StripeEnv) {
  const access = await requireOrgAccess(userId, { id: organizationId }, "billing:manage");
  const availability = await billingAvailability(cfg);
  if (!availability.enabled)
    throw new AppError(
      "FEATURE_DISABLED",
      "Online billing isn't enabled yet. Contact us to change your plan.",
    );
  if (!availability.configured) throw new AppError("UNAVAILABLE", "Billing is not configured.");
  return access;
}

/** Stripe customer for the organization, created once (idempotent across concurrent calls). */
async function ensureCustomer(stripe: Stripe, organizationId: string, email: string | null) {
  const sub = await db.subscription.findUniqueOrThrow({
    where: { organizationId },
    select: { stripeCustomerId: true, organization: { select: { name: true } } },
  });
  if (sub.stripeCustomerId) {
    // A customer deleted in the Stripe dashboard would otherwise break Checkout for good.
    const existing = await stripe.customers.retrieve(sub.stripeCustomerId).catch((e: { code?: string }) => (e?.code === "resource_missing" ? null : Promise.reject(e)));
    if (existing && !("deleted" in existing && existing.deleted)) return sub.stripeCustomerId;
    log.warn("billing.customer_missing_recreating", { organizationId, customerId: sub.stripeCustomerId });
    await db.subscription.update({ where: { organizationId }, data: { stripeCustomerId: null } });
  }
  const customer = await stripe.customers.create(
    { name: sub.organization.name, ...(email ? { email } : {}), metadata: { organizationId } },
    // Day-scoped key: concurrent clicks share one customer; a re-creation tomorrow isn't blocked by Stripe's 24 h key cache.
    { idempotencyKey: `customer:${organizationId}:${new Date().toISOString().slice(0, 10)}` },
  );
  // Only the first writer stores its id; a concurrent request reuses it.
  await db.subscription.updateMany({
    where: { organizationId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });
  return (
    await db.subscription.findUniqueOrThrow({
      where: { organizationId },
      select: { stripeCustomerId: true },
    })
  ).stripeCustomerId!;
}

export async function createCheckoutSession(
  userId: string,
  organizationId: string,
  tier: PaidTier,
  cfg: StripeEnv = stripeEnv(),
): Promise<{ url: string }> {
  const access = await requireBilling(userId, organizationId, cfg);
  if (!PAID_TIERS.includes(tier)) throw new AppError("VALIDATION", "Unknown plan.");
  const current = await db.subscription.findUniqueOrThrow({
    where: { organizationId },
    select: { planTier: true, status: true, stripeSubscriptionId: true },
  });
  // An existing paid subscription is changed in the portal (proration, payment method), never duplicated.
  if (current.stripeSubscriptionId && effectiveTier(current) !== "FREE")
    throw new AppError(
      "CONFLICT",
      "You already have a subscription. Change plans from Manage billing.",
    );
  const stripe = stripeClient(cfg);
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  const customer = await ensureCustomer(stripe, organizationId, user?.email ?? null);
  const origin = appOrigin();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: organizationId,
    line_items: [{ price: cfg.prices[tier]!, quantity: 1 }],
    subscription_data: { metadata: { organizationId } },
    metadata: { organizationId, tier },
    allow_promotion_codes: true,
    success_url: `${origin}/${access.organizationSlug}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/${access.organizationSlug}/billing?checkout=cancelled`,
  });
  if (!session.url)
    throw new AppError("UNAVAILABLE", "Stripe did not return a checkout link. Please try again.");
  await writeAuditLog({
    organizationId,
    actorId: userId,
    action: "billing.checkout_started",
    entityType: "Subscription",
    metadata: { tier, sessionId: session.id },
  });
  return { url: session.url };
}

export async function createPortalSession(
  userId: string,
  organizationId: string,
  cfg: StripeEnv = stripeEnv(),
): Promise<{ url: string }> {
  const access = await requireBilling(userId, organizationId, cfg);
  const sub = await db.subscription.findUniqueOrThrow({
    where: { organizationId },
    select: { stripeCustomerId: true },
  });
  if (!sub.stripeCustomerId)
    throw new AppError("CONFLICT", "There's no billing account yet. Choose a plan first.");
  const session = await stripeClient(cfg).billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${appOrigin()}/${access.organizationSlug}/billing`,
  });
  return { url: session.url };
}

/**
 * After Checkout redirects back, sync right away instead of waiting for the
 * webhook. The session must belong to this organization.
 */
export async function confirmCheckout(
  userId: string,
  organizationId: string,
  sessionId: string,
  cfg: StripeEnv = stripeEnv(),
) {
  await requireOrgAccess(userId, { id: organizationId }, "org:read");
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  const session = await stripeClient(cfg).checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== organizationId) return null;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  return subscriptionId ? syncSubscription(subscriptionId, { organizationId }, cfg) : null;
}

// ── Sync ──────────────────────────────────────────────────────

export async function syncSubscription(
  subscriptionId: string,
  hint: { organizationId?: string | null } = {},
  cfg: StripeEnv = stripeEnv(),
) {
  const stripe = stripeClient(cfg);
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId = idOf(sub.customer);
  const row =
    (customerId
      ? await db.subscription.findUnique({ where: { stripeCustomerId: customerId } })
      : null) ??
    (await db.subscription.findUnique({ where: { stripeSubscriptionId: sub.id } })) ??
    (sub.metadata?.organizationId || hint.organizationId
      ? await db.subscription.findUnique({
          where: { organizationId: (sub.metadata?.organizationId || hint.organizationId)! },
        })
      : null);
  if (!row) {
    log.warn("billing.sync_unknown_customer", { subscriptionId, customerId });
    return null;
  }
  const mapped = mapSubscription(sub, cfg);
  if (!mapped.tier)
    log.error("billing.unknown_price", {
      subscriptionId,
      priceId: mapped.data.stripePriceId,
      organizationId: row.organizationId,
    });
  if (!shouldApply(row, mapped.data)) {
    log.info("billing.sync_stale_subscription_ignored", {
      subscriptionId,
      current: row.stripeSubscriptionId,
    });
    return row;
  }
  // Two live subscriptions (e.g. Checkout paid in two tabs) means double billing: the newer one wins here, and it's flagged for a refund.
  if (row.stripeSubscriptionId && row.stripeSubscriptionId !== sub.id && effectiveTier(row) !== "FREE" && effectiveTier({ planTier: mapped.data.planTier, status: mapped.data.status }) !== "FREE") {
    log.error("billing.multiple_active_subscriptions", { organizationId: row.organizationId, previous: row.stripeSubscriptionId, current: sub.id });
    await writeAuditLog({ organizationId: row.organizationId, action: "billing.multiple_active_subscriptions", entityType: "Subscription", entityId: row.id, metadata: { previous: row.stripeSubscriptionId, current: sub.id } });
  }
  const updated = await db.subscription.update({ where: { id: row.id }, data: mapped.data });
  if (row.planTier !== updated.planTier || row.status !== updated.status) {
    await writeAuditLog({
      organizationId: row.organizationId,
      action: "billing.subscription_changed",
      entityType: "Subscription",
      entityId: row.id,
      metadata: {
        from: `${row.planTier}/${row.status}`,
        to: `${updated.planTier}/${updated.status}`,
        subscriptionId,
      },
    });
    log.info("billing.subscription_changed", {
      organizationId: row.organizationId,
      from: row.planTier,
      to: updated.planTier,
      status: updated.status,
    });
  }
  return updated;
}

export type WebhookResult = { status: number; body: Record<string, unknown> };

/** Verify, deduplicate and apply one webhook delivery. */
export async function handleWebhook(
  payload: string,
  signature: string | null,
  cfg: StripeEnv = stripeEnv(),
): Promise<WebhookResult> {
  if (!cfg.webhookSecret || !cfg.secretKey)
    return { status: 503, body: { error: "billing not configured" } };
  let event: Stripe.Event;
  try {
    event = stripeClient(cfg).webhooks.constructEvent(payload, signature ?? "", cfg.webhookSecret);
  } catch {
    log.warn("billing.webhook_bad_signature");
    return { status: 400, body: { error: "invalid signature" } };
  }
  const seen = await db.stripeEvent.findUnique({ where: { id: event.id } });
  if (seen?.processedAt) return { status: 200, body: { received: true, duplicate: true } };
  if (!seen)
    await db.stripeEvent.create({ data: { id: event.id, type: event.type } }).catch(() => {}); // a concurrent delivery may have inserted it
  const { subscriptionId, organizationId } = subscriptionIdOf(event);
  try {
    if (subscriptionId) await syncSubscription(subscriptionId, { organizationId }, cfg);
    await db.stripeEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date(), error: null },
    });
    return { status: 200, body: { received: true } };
  } catch (error) {
    log.error("billing.webhook_failed", { eventId: event.id, type: event.type, error });
    await db.stripeEvent
      .update({
        where: { id: event.id },
        data: { error: String((error as Error)?.message ?? error).slice(0, 1000) },
      })
      .catch(() => {});
    // Non-2xx makes Stripe retry later; the event stays unprocessed until then.
    return { status: 500, body: { error: "processing failed" } };
  }
}

export { tierName };
