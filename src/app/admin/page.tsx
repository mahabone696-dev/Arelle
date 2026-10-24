import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CostChart } from "@/components/charts/cost-chart";
import { usd } from "@/lib/format";
import { requireSessionUser } from "@/server/auth/session";
import { adminOverview, subscriptionLabel } from "@/server/admin/service";
import { tierName } from "@/server/billing/plans";
import { cn } from "@/lib/utils";
import { killSwitchAction, providerToggleAction } from "./actions";
import { KillSwitchForm, ProviderToggle } from "./controls";
import { AdminTable, Td } from "./table";

export const metadata: Metadata = { title: "Overview" };

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "bad" }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("tabular mt-0.5 text-xl font-semibold", tone === "bad" && "text-destructive")}>{value}</div>
    </div>
  );
}

export default async function AdminOverviewPage() {
  const user = await requireSessionUser();
  const o = await adminOverview(user.id);
  const ks = o.killSwitch;
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <Card className={cn(ks.enabled && "border-destructive")}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Global scan kill switch {ks.enabled ? <Badge variant="destructive">On — scans paused</Badge> : <Badge>Off</Badge>}
          </CardTitle>
          <CardDescription>
            {ks.enabled
              ? `New scan jobs and public audits are not dispatched. Reason: ${ks.reason ?? "—"}. Jobs already queued are skipped without calling a provider.`
              : "When on, no new scan jobs are dispatched and the free audit pauses. Use during provider incidents or runaway cost."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <KillSwitchForm enabled={ks.enabled} action={killSwitchAction} />
        </CardContent>
      </Card>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Stat label="Organizations" value={o.counts.orgs} />
        <Stat label="Users" value={o.counts.users} />
        <Stat label="Projects" value={o.counts.projects} />
        <Stat label="Paying orgs" value={o.paying} />
        <Stat label="Scans (24h)" value={o.counts.scans24h} />
        <Stat label="Failed jobs (24h)" value={o.counts.failedJobs24h} tone={o.counts.failedJobs24h ? "bad" : undefined} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Estimated AI costs · last 30 days</CardTitle>
          <CardDescription>Estimates from token usage and configured pricing — check provider invoices for actual spend. Demo data excluded.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total" value={usd(o.costs.total30d)} />
            <Stat label="Scans" value={usd(o.costs.scans30d)} />
            <Stat label={`Onboarding (${o.costs.onboardingRuns30d} runs)`} value={usd(o.costs.onboarding30d)} />
            <Stat label="Free audits" value={usd(o.costs.audits30d)} />
          </div>
          {o.costs.daily.length ? <CostChart data={o.costs.daily} /> : <p className="text-[13px] text-muted-foreground">No scan answers in the last 30 days.</p>}
        </CardContent>
      </Card>

      <section>
        <h2 className="mb-2 text-sm font-medium">Provider usage</h2>
        <AdminTable head={["Provider", "Status", { label: "Answers 24h", right: true }, { label: "Cost 24h", right: true }, { label: "Answers 30d", right: true }, { label: "Tokens 30d", right: true }, { label: "Cost 30d", right: true }, { label: "Daily cap", right: true }, ""]}>
          {o.providers.map((p) => (
            <tr key={p.slug}>
              <Td>
                <div className="font-medium">{p.displayName}</div>
                <div className="text-xs text-muted-foreground">{p.slug}</div>
              </Td>
              <Td>
                {p.ready ? <Badge variant="success">Ready</Badge> : p.isEnabled ? <Badge variant="warning">{p.unavailableReason ?? "Unavailable"}</Badge> : <Badge>Disabled</Badge>}
              </Td>
              <Td right>{p.answers24h}</Td>
              <Td right>{usd(p.cost24h)}</Td>
              <Td right>{p.answers30d}</Td>
              <Td right>{p.tokens30d.toLocaleString("en-US")}</Td>
              <Td right>{usd(p.cost30d)}</Td>
              <Td right>{p.dailyQueryCap.toLocaleString("en-US")}</Td>
              <Td right>
                <ProviderToggle enabled={p.isEnabled} name={p.displayName} toggle={providerToggleAction.bind(null, p.slug, !p.isEnabled)} />
              </Td>
            </tr>
          ))}
        </AdminTable>
      </section>

      <div className="grid gap-6 md:grid-cols-2 [&>*]:min-w-0">
        <section>
          <h2 className="mb-2 text-sm font-medium">Subscriptions</h2>
          <AdminTable head={["Plan · status", "Entitled to", { label: "Orgs", right: true }]} empty="No subscriptions.">
            {o.subscriptions.map((s) => (
              <tr key={`${s.tier}-${s.status}`}>
                <Td>{subscriptionLabel(s.tier, s.status)}</Td>
                <Td>{tierName(s.effective)}</Td>
                <Td right>{s.count}</Td>
              </tr>
            ))}
          </AdminTable>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-medium">Free audit funnel · 30 days</h2>
          <AdminTable head={["Outcome", { label: "Count", right: true }]}>
            {(["COMPLETED", "FAILED", "PENDING", "RUNNING", "RATE_LIMITED"] as const).map((k) => (
              <tr key={k}>
                <Td>{k.toLowerCase().replace("_", " ")}</Td>
                <Td right>{o.audits.byStatus[k] ?? 0}</Td>
              </tr>
            ))}
            <tr>
              <Td className="font-medium">Signed up from an audit</Td>
              <Td right className="font-medium">
                {o.audits.conversions30d}
              </Td>
            </tr>
          </AdminTable>
        </section>
      </div>
    </div>
  );
}
