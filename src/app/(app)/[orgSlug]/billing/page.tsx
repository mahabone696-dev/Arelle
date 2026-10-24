import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Check, CircleAlert, CreditCard } from "lucide-react";
import { SimpleShell } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireOrgPage } from "@/server/auth/session";
import { listOrganizationsForUser } from "@/server/organizations/service";
import { getBillingOverview } from "@/server/billing/overview";
import { confirmCheckout } from "@/server/billing/stripe";
import { PAID_TIERS, PLANS, type PaidTier } from "@/server/billing/plans";
import type { PlanTier } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import { checkoutAction, portalAction } from "./actions";
import { StripeButton } from "./billing-buttons";

export const metadata: Metadata = { title: "Plan & billing" };

const ORDER: PlanTier[] = ["FREE", ...PAID_TIERS];
const date = (d: Date) => d.toISOString().slice(0, 10);
const fmt = (n: number) => n.toLocaleString("en-US");

function features(tier: PlanTier) {
  const l = PLANS[tier].limits;
  return [
    `${l.projects} project${l.projects === 1 ? "" : "s"}`,
    `${fmt(l.prompts)} prompts per project`,
    PLANS[tier].cadence,
    `${fmt(l.queriesPerMonth)} AI queries / month`,
    l.actionEngine ? "Recommendations & action tracking" : null,
    l.reports ? "Reports & team features" : null,
  ].filter(Boolean) as string[];
}

function Meter({ label, used, limit, hint }: { label: string; used: number; limit: number; hint?: string }) {
  const ratio = limit ? Math.min(1, used / limit) : 0;
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[13px]">
        <span>{label}</span>
        <span className="tabular whitespace-nowrap text-muted-foreground">
          <span className="font-medium text-foreground">{fmt(used)}</span> / {fmt(limit)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={label}>
        <div className={cn("h-full rounded-full", ratio >= 1 ? "bg-destructive" : ratio >= 0.8 ? "bg-warning" : "bg-foreground/70")} style={{ width: `${ratio * 100}%` }} />
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export default async function BillingPage({ params, searchParams }: { params: Promise<{ orgSlug: string }>; searchParams: Promise<{ checkout?: string; session_id?: string }> }) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const { user, access } = await requireOrgPage(orgSlug);
  // Back from Stripe Checkout: sync now rather than waiting for the webhook.
  if (sp.checkout === "success" && sp.session_id) await confirmCheckout(user.id, access.organizationId, sp.session_id).catch(() => null);
  const [orgs, o] = await Promise.all([listOrganizationsForUser(user.id), getBillingOverview(user.id, orgSlug)]);
  const sub = o.subscription;
  const subscribed = Boolean(sub?.stripeSubscriptionId) && o.tier !== "FREE";
  const canBuy = o.canManage && o.availability.ready;
  const lapsed = sub && sub.planTier !== "FREE" && o.tier === "FREE";

  return (
    <SimpleShell user={user} orgs={orgs} orgSlug={orgSlug}>
      <div className="mx-auto grid max-w-5xl gap-4">
        <Link href={`/${orgSlug}`} className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back to projects
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Plan & billing</h1>
          {o.availability.ready && o.availability.testMode ? <Badge variant="warning">Stripe test mode</Badge> : null}
        </div>

        {sp.checkout === "success" ? (
          <Card className="flex items-center gap-3 border-success/40 px-5 py-3 text-[13px]">
            <Check className="size-4 text-success" /> Thanks — {subscribed ? `you're on ${o.plan.name}.` : "your payment is being confirmed. This page updates within a minute."}
          </Card>
        ) : sp.checkout === "cancelled" ? (
          <Card className="px-5 py-3 text-[13px] text-muted-foreground">Checkout was cancelled. Nothing was charged.</Card>
        ) : null}
        {sub?.status === "PAST_DUE" ? (
          <Card className="flex items-start gap-3 border-warning/50 px-5 py-3 text-[13px]">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> Your last payment failed. Stripe will retry; update your payment method in Manage billing to keep {PLANS[sub.planTier].name} features.
          </Card>
        ) : null}
        {lapsed ? (
          <Card className="flex items-start gap-3 border-warning/50 px-5 py-3 text-[13px]">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" /> Your {PLANS[sub!.planTier].name} subscription is {sub!.status.toLowerCase().replace("_", " ")}. Free plan limits apply until you subscribe again; your data is kept.
          </Card>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle>Current plan</CardTitle>
              <CardDescription>
                {o.plan.name}
                {o.plan.priceUsd ? ` · $${o.plan.priceUsd}/month` : " · free"}
                {subscribed && sub?.currentPeriodEnd ? ` · ${sub.cancelAtPeriodEnd ? "ends" : "renews"} ${date(sub.currentPeriodEnd)}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ul className="grid gap-1.5 text-[13px]">
                {features(o.tier).map((f) => (
                  <li key={f} className="flex items-center gap-2">
                    <Check className="size-3.5 text-success" aria-hidden /> {f}
                  </li>
                ))}
              </ul>
              {sub?.stripeCustomerId && o.canManage && o.availability.ready ? (
                <div className="w-fit">
                  <StripeButton action={portalAction.bind(null, orgSlug)} variant="outline">
                    <CreditCard /> Manage billing
                  </StripeButton>
                </div>
              ) : null}
              {!o.canManage ? <p className="text-xs text-muted-foreground">Only the organization owner can change the plan.</p> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Usage</CardTitle>
              <CardDescription>Limits are enforced when a scan starts. Days and months are UTC.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Meter label="Projects" used={o.usage.projects.used} limit={o.usage.projects.limit} hint={o.usage.projects.used > o.usage.projects.limit ? "Projects over the limit stay readable but don't scan." : undefined} />
              <Meter label="AI queries this month" used={o.usage.queriesMonth.used} limit={o.usage.queriesMonth.limit} />
              <Meter label="AI queries today" used={o.usage.queriesToday.used} limit={o.usage.queriesToday.limit} />
              <Meter label="Manual scans today" used={o.usage.manualScansToday.used} limit={o.usage.manualScansToday.limit} />
              {o.usage.projectList.length ? (
                <div className="grid gap-1 border-t pt-3 text-[13px]">
                  {o.usage.projectList.map((p) => (
                    <div key={p.id} className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate">{p.name}</span>
                      <span className={cn("tabular whitespace-nowrap text-xs", p.overPromptLimit || !p.scanning ? "text-destructive" : "text-muted-foreground")}>
                        {!p.scanning ? "not scanning · " : ""}
                        {p.activePrompts} / {o.plan.limits.prompts} prompts{p.overPromptLimit && p.scanning ? " · top " + o.plan.limits.prompts + " scanned" : ""}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <h2 className="mt-2 text-sm font-medium">Plans</h2>
        {!o.availability.ready ? (
          <p className="text-[13px] text-muted-foreground">{o.availability.enabled ? "Online billing isn't configured on this server." : "Online billing isn't enabled yet."} Contact us to change your plan; limits below apply either way.</p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {ORDER.map((t) => {
            const p = PLANS[t];
            const current = t === o.tier;
            return (
              <Card key={t} className={cn("flex flex-col", current && "ring-2 ring-foreground/80")}>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    {p.name}
                    {current ? <Badge variant="default">Current</Badge> : null}
                  </CardTitle>
                  <CardDescription>
                    <span className="tabular text-2xl font-semibold text-foreground">${p.priceUsd}</span> / month
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid flex-1 content-between gap-4">
                  <ul className="grid gap-1.5 text-[13px]">
                    {features(t).map((f) => (
                      <li key={f} className="flex gap-2">
                        <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden /> {f}
                      </li>
                    ))}
                  </ul>
                  {t === "FREE" || current ? null : subscribed ? (
                    canBuy ? (
                      <StripeButton action={portalAction.bind(null, orgSlug)} variant="outline">
                        Switch in Manage billing
                      </StripeButton>
                    ) : null
                  ) : (
                    <StripeButton action={checkoutAction.bind(null, orgSlug, t as PaidTier)} disabled={!canBuy}>
                      Choose {p.name}
                    </StripeButton>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Prices in USD, billed monthly by Stripe. Plan changes and cancellation are handled in Manage billing; downgrades keep your data.</p>
      </div>
    </SimpleShell>
  );
}
