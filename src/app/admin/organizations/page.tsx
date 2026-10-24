import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { requireSessionUser } from "@/server/auth/session";
import { adminOrganizations, subscriptionLabel } from "@/server/admin/service";
import { tierName } from "@/server/billing/plans";
import { AdminTable, SearchBox, Td, when } from "../table";

export const metadata: Metadata = { title: "Organizations" };

export default async function AdminOrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, user] = await Promise.all([searchParams, requireSessionUser()]);
  const rows = await adminOrganizations(user.id, q?.trim() || undefined);
  return (
    <>
      <SearchBox placeholder="Search name or slug" q={q} />
      <AdminTable head={["Organization", "Subscription", "Entitled to", { label: "Members", right: true }, { label: "Projects", right: true }, "Period end", "Created"]} empty="No organizations match.">
        {rows.map((o) => (
          <tr key={o.id}>
            <Td>
              <div className="font-medium">
                {o.name} {o.isDemo ? <Badge variant="outline">demo</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">/{o.slug}</div>
            </Td>
            <Td>
              {o.subscription ? subscriptionLabel(o.subscription.planTier, o.subscription.status) : "—"}
              {o.subscription?.cancelAtPeriodEnd ? <div className="text-xs text-muted-foreground">cancels at period end</div> : null}
              {o.subscription?.stripeSubscriptionId ? <div className="text-xs text-muted-foreground">{o.subscription.stripeSubscriptionId}</div> : null}
            </Td>
            <Td>{tierName(o.effective)}</Td>
            <Td right>{o._count.members}</Td>
            <Td right>{o._count.projects}</Td>
            <Td className="whitespace-nowrap">{when(o.subscription?.currentPeriodEnd)}</Td>
            <Td className="whitespace-nowrap">{when(o.createdAt)}</Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}
