import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { requireSessionUser } from "@/server/auth/session";
import { adminProjects } from "@/server/admin/service";
import { AdminTable, SearchBox, Td, when } from "../table";

export const metadata: Metadata = { title: "Projects" };

export default async function AdminProjectsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, user] = await Promise.all([searchParams, requireSessionUser()]);
  const rows = await adminProjects(user.id, q?.trim() || undefined);
  return (
    <>
      <SearchBox placeholder="Search name or domain" q={q} />
      <AdminTable head={["Project", "Organization", "Setup", { label: "Prompts", right: true }, { label: "Competitors", right: true }, { label: "Scans", right: true }, "Last scan", "Created"]} empty="No projects match.">
        {rows.map((p) => (
          <tr key={p.id}>
            <Td>
              <div className="font-medium">
                {p.name} {p.archivedAt ? <Badge variant="outline">archived</Badge> : null}
              </div>
              <div className="text-xs text-muted-foreground">
                {p.domain} · {p.country}
              </div>
            </Td>
            <Td>
              {p.organization.name} {p.organization.isDemo ? <Badge variant="outline">demo</Badge> : null}
            </Td>
            <Td>{p.onboardingStep.toLowerCase()}</Td>
            <Td right>{p._count.prompts}</Td>
            <Td right>{p._count.competitors}</Td>
            <Td right>{p._count.scans}</Td>
            <Td className="whitespace-nowrap">{p.scans[0] ? `${when(p.scans[0].createdAt)} · ${p.scans[0].status.toLowerCase()}` : "—"}</Td>
            <Td className="whitespace-nowrap">{when(p.createdAt)}</Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}
