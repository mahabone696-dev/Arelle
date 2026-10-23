import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { usd } from "@/lib/format";
import { requireSessionUser } from "@/server/auth/session";
import { adminScans } from "@/server/admin/service";
import { AdminTable, SearchBox, Td, when } from "../table";

export const metadata: Metadata = { title: "Scans" };

const TONE = { COMPLETED: "success", PARTIAL: "warning", FAILED: "destructive", CANCELLED: "outline", QUEUED: "default", RUNNING: "default" } as const;

export default async function AdminScansPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const [{ q }, user] = await Promise.all([searchParams, requireSessionUser()]);
  const rows = await adminScans(user.id, q?.trim() || undefined);
  return (
    <>
      <SearchBox placeholder="Search scan id or domain" q={q} />
      <AdminTable head={["Scan", "Status", { label: "Done / planned", right: true }, { label: "Failed", right: true }, { label: "Skipped", right: true }, { label: "Est. cost", right: true }, { label: "Actual", right: true }, "Analysis", "Created"]} empty="No scans match.">
        {rows.map((s) => (
          <tr key={s.id}>
            <Td>
              <div className="font-medium">
                {s.project.domain} {s.isDemo ? <Badge variant="outline">demo</Badge> : null}
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                {s.id} · {s.scanType.toLowerCase()}
              </div>
              {s.errorSummary ? <div className="mt-0.5 max-w-xs text-xs text-destructive">{s.errorSummary}</div> : null}
            </Td>
            <Td>
              <Badge variant={TONE[s.status]}>{s.status.toLowerCase()}</Badge>
            </Td>
            <Td right>
              {s.completedCount} / {s.expectedQueryCount}
            </Td>
            <Td right>{s.failedCount}</Td>
            <Td right>{s.skippedCount}</Td>
            <Td right>{usd(s.estimatedCost.toNumber())}</Td>
            <Td right>{usd(s.actualCost.toNumber())}</Td>
            <Td>{s.analysisStatus?.toLowerCase() ?? "—"}</Td>
            <Td className="whitespace-nowrap">{when(s.createdAt)}</Td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}
