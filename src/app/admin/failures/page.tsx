import type { Metadata } from "next";
import { requireSessionUser } from "@/server/auth/session";
import { adminFailures } from "@/server/admin/service";
import { AdminTable, Td, when } from "../table";

export const metadata: Metadata = { title: "Failed jobs" };

export default async function AdminFailuresPage() {
  const user = await requireSessionUser();
  const f = await adminFailures(user.id);
  return (
    <div className="grid gap-6 [&>*]:min-w-0">
      <section>
        <h2 className="mb-2 text-sm font-medium">Failed query jobs by error · last 7 days</h2>
        {f.byCode.length ? (
          <div className="flex flex-wrap gap-2">
            {f.byCode.map((c) => (
              <span key={c.code} className="rounded-md border bg-card px-2.5 py-1 font-mono text-xs">
                {c.code} <span className="tabular text-muted-foreground">×{c.count}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">No failed jobs in the last 7 days.</p>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-medium">Recent failed query jobs</h2>
        <AdminTable head={["When", "Provider", "Project · prompt", "Error", { label: "Attempts", right: true }]} empty="No failed jobs.">
          {f.jobs.map((j) => (
            <tr key={j.id}>
              <Td className="whitespace-nowrap">{when(j.updatedAt)}</Td>
              <Td>{j.provider.slug}</Td>
              <Td>
                <div>{j.scan.project.domain}</div>
                <div className="max-w-xs truncate text-xs text-muted-foreground">{j.prompt.text}</div>
                <div className="font-mono text-[11px] text-muted-foreground">scan {j.scanId}</div>
              </Td>
              <Td>
                <div className="font-mono text-xs">{j.errorCode ?? "UNKNOWN"}</div>
                {j.lastError ? <div className="max-w-sm text-xs text-muted-foreground">{j.lastError.slice(0, 300)}</div> : null}
              </Td>
              <Td right>{j.attempts}</Td>
            </tr>
          ))}
        </AdminTable>
      </section>
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <section>
          <h2 className="mb-2 text-sm font-medium">Failed scans and analyses</h2>
          <AdminTable head={["When", "Project", "Error"]} empty="None.">
            {f.scans.map((s) => (
              <tr key={s.id}>
                <Td className="whitespace-nowrap">{when(s.updatedAt)}</Td>
                <Td>
                  <div>{s.project.domain}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{s.id}</div>
                </Td>
                <Td className="text-xs">{s.status === "FAILED" ? (s.errorSummary ?? "Scan failed") : `Analysis: ${s.analysisError ?? "failed"}`}</Td>
              </tr>
            ))}
          </AdminTable>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-medium">Failed free audits</h2>
          <AdminTable head={["When", "Domain", "Reason"]} empty="None.">
            {f.audits.map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap">{when(a.updatedAt)}</Td>
                <Td>{a.domain}</Td>
                <Td className="text-xs">{a.error ?? "—"}</Td>
              </tr>
            ))}
          </AdminTable>
        </section>
      </div>
    </div>
  );
}
